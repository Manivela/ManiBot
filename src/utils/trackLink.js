// A Discord masked link to the song; the <> stops a preview embed per message.
const trackLink = ({ title, url }) =>
  url ? `[${title.replace(/[[\]]/g, "\\$&")}](<${url}>)` : title;

module.exports = { trackLink };
