#!/bin/zsh
# Double-click to start the Rainy Words server. Close this window to stop it.
# It first writes this computer's current network address into public/config.js.
cd "${0:A:h}"
export PATH="$HOME/.local/node/bin:$PATH"
node scripts/set-host.js --start
npm start
