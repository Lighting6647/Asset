const { handleApiRequest } = require('../server');

module.exports = async (req, res) => {
  try {
    await handleApiRequest(req, res);
  } catch (err) {
    console.error('API Error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
    }
  }
};
