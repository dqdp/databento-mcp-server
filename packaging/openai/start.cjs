const path = require('node:path');
const os = require('node:os');
require('dotenv').config({ path: path.join(os.homedir(), '.databento-mcp/.env'), quiet: true });
require('./server/mcp/extension-entrypoint.js');
