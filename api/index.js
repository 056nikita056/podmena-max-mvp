import { createServer } from '../server/http.js';

const server = createServer();

export default function handler(req, res) {
  const route = req.query?.route;
  if (typeof route !== 'string' || !/^[a-zA-Z0-9/_-]+$/.test(route)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  req.url = `/api/${route}`;
  server.emit('request', req, res);
}
