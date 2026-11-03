/*
 * Rainy Words — the one place the server address lives.
 * server.js and the browser client both read this file, so players never type an IP or a port.
 */
(function (root) {
  const RAINY_CONFIG = {
    SERVER_HOST: '192.168.1.37', // ← the server computer's LAN IP; update it whenever the network changes
    SERVER_PORT: 3210,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RAINY_CONFIG;
  else root.RAINY_CONFIG = RAINY_CONFIG;
})(typeof window !== 'undefined' ? window : globalThis);
