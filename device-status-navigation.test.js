const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

test('dashboard status rows are accessible buttons linked to the device filter', () => {
  assert.match(appSource, /<button[^>]+class="device-status-row"/);
  assert.match(appSource, /data-status="\$\{label\.toLowerCase\(\)\}"/);
  assert.match(appSource, /deviceStatusBars\.addEventListener\('click'/);
  assert.match(appSource, /openDeviceManagement\(statusRow\.dataset\.status/);
});
