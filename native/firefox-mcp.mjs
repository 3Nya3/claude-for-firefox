import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const user = os.userInfo().username;
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\claude-firefox-bridge-${user}`
  : path.join(os.tmpdir(), `claude-firefox-bridge-${user}.sock`);
const CALL_TIMEOUT_MS = 120000;

// Parameter types for the common arguments. Without them, MCP clients only see an untyped
// object and may send arrays and numbers as JSON text ("[587, 617]"), which the extension
// rejects ("coordinate: expected tuple, received string"). Unlisted arguments still pass through.
const tabId = { type: 'integer', description: 'Tab id from tabs_context_mcp.' };
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in screenshot pixels.' };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: true });

const TOOLS = {
  tabs_context_mcp: ['List the tabs in the Firefox Claude tab group. Call first; pass createIfEmpty:true to create one.',
    schema({ createIfEmpty: { type: 'boolean' } })],
  tabs_create_mcp: ['Open a new empty tab in the Firefox Claude tab group.', schema()],
  tabs_close_mcp: ['Close a tab in the Firefox Claude tab group.', schema({ tabId }, ['tabId'])],
  navigate: ['Navigate a Firefox tab to a URL, or "back"/"forward".', schema({ tabId, url: { type: 'string' } }, ['tabId', 'url'])],
  computer: ['Mouse, keyboard and screenshot actions on a Firefox tab.', schema({
    tabId,
    action: { type: 'string', enum: ['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'screenshot', 'wait', 'scroll', 'scroll_to', 'left_click_drag', 'zoom', 'hover'] },
    coordinate: point,
    start_coordinate: point,
    region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] for zoom.' },
    text: { type: 'string' },
    ref: { type: 'string' },
    modifiers: { type: 'string' },
    scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    scroll_amount: { type: 'number' },
    duration: { type: 'number' },
    repeat: { type: 'number' },
  }, ['action', 'tabId'])],
  read_page: ['Accessibility tree of a Firefox tab.', schema({ tabId, filter: { type: 'string' }, depth: { type: 'number' }, ref_id: { type: 'string' } }, ['tabId'])],
  get_page_text: ['Plain text of a Firefox tab.', schema({ tabId }, ['tabId'])],
  find: ['Find elements on a Firefox tab from a natural language query.', schema({ tabId, query: { type: 'string' } }, ['tabId', 'query'])],
  form_input: ['Set a form field value on a Firefox tab.', schema({ tabId, ref: { type: 'string' }, value: {} }, ['tabId', 'ref', 'value'])],
  javascript_tool: ['Run JavaScript in a Firefox tab.', schema({ tabId, action: { type: 'string', enum: ['javascript_exec'] }, text: { type: 'string' } }, ['tabId', 'text'])],
  read_console_messages: ['Read console messages from a Firefox tab.', schema({ tabId })],
  read_network_requests: ['Read network requests from a Firefox tab.', schema({ tabId })],
  resize_window: ['Resize the Firefox window.', schema({ tabId, width: { type: 'number' }, height: { type: 'number' } })],
  file_upload: ['Upload files to a file input in a Firefox tab.', schema({ tabId })],
  upload_image: ['Upload an image to a Firefox tab.', schema({ tabId })],
  gif_creator: ['Record and export a GIF of Firefox browser actions.', schema({ tabId })],
  browser_batch: ['Run several Firefox browser actions in one call.',
    schema({ actions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'object' } } } } }, ['actions'])],
  shortcuts_list: ['List available shortcuts.', schema()],
  shortcuts_execute: ['Execute a shortcut.', schema()],
};

// Arguments that must not be strings. Clients that ignore the schema may still send them as
// JSON text; parse those back. Free-text arguments (text, query, url, ...) are left alone.
const NON_STRING_ARGS = new Set(['coordinate', 'start_coordinate', 'region', 'tabId', 'scroll_amount', 'duration',
  'repeat', 'width', 'height', 'depth', 'createIfEmpty', 'actions', 'input']);
function coerceArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = { ...args };
  for (const [key, value] of Object.entries(out)) {
    if (NON_STRING_ARGS.has(key) && typeof value === 'string') {
      try { out[key] = JSON.parse(value); } catch { /* leave it for the extension to report */ }
    }
  }
  // browser_batch: each action is { name, input }, where input may itself be JSON text.
  if (Array.isArray(out.actions)) {
    out.actions = out.actions.map((action) => {
      const parsed = coerceArgs(action);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed, input: coerceArgs(parsed.input) } : parsed;
    });
  }
  return out;
}

const callFirefox = (tool, args) => new Promise((resolve, reject) => {
  const socket = net.connect(socketPath);
  let pending = Buffer.alloc(0);
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Firefox did not answer within ${CALL_TIMEOUT_MS / 1000}s`)); }, CALL_TIMEOUT_MS);
  socket.on('error', (e) => { clearTimeout(timer); reject(new Error(`Firefox native host not reachable (${e.code || e.message}). Start Firefox with ~/.claude/firefox/launch.bat`)); });
  socket.on('connect', () => {
    const body = Buffer.from(JSON.stringify({ method: 'execute_tool', params: { tool, args: args || {}, client_id: `firefox-mcp-${process.pid}` } }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    setTimeout(() => socket.write(Buffer.concat([header, body])), 300);
  });
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 4 || pending.length < 4 + pending.readUInt32LE(0)) return;
    clearTimeout(timer);
    const message = JSON.parse(pending.subarray(4, 4 + pending.readUInt32LE(0)).toString('utf8'));
    socket.destroy();
    resolve(message);
  });
});

const toMcpContent = (blocks) => (Array.isArray(blocks) ? blocks : [{ type: 'text', text: String(blocks) }]).map((block) =>
  block.type === 'image' && block.source
    ? { type: 'image', data: block.source.data, mimeType: block.source.media_type }
    : { type: 'text', text: block.text ?? JSON.stringify(block) });

const callTool = async (name, args) => {
  const reply = await callFirefox(name, args);
  if (reply.error) return { isError: true, content: toMcpContent(reply.error.content) };
  return { content: toMcpContent(reply.result?.content) };
};

const methods = {
  initialize: () => ({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'firefox', version: '1.0.0' } }),
  'tools/list': () => ({
    tools: Object.entries(TOOLS).map(([name, [description, inputSchema]]) => ({ name, description, inputSchema })),
  }),
  'tools/call': ({ name, arguments: args }) => {
    if (!TOOLS[name]) throw new Error(`Unknown tool: ${name}`);
    return callTool(name, coerceArgs(args));
  },
  ping: () => ({}),
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  try {
    const handler = methods[request.method];
    if (!handler) return send({ id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
    send({ id: request.id, result: await handler(request.params || {}) });
  } catch (e) {
    send({ id: request.id, error: { code: -32000, message: e.message } });
  }
});
