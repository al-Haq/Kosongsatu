// Browser parts of the feature modules (see docs/PLUGINS.md).
import documents from "./ext/documents.mjs";
import recurring from "./ext/recurring.mjs";
import tax from "./ext/tax.mjs";
import payments from "./ext/payments.mjs";
import comms from "./ext/comms.mjs";
import portal from "./ext/portal.mjs";
import books from "./ext/books.mjs";
import ops from "./ext/ops.mjs";
import team from "./ext/team.mjs";
import platform from "./ext/platform.mjs";
import trash from "./ext/trash.mjs";
export const UI_PLUGINS = [
  ["documents", documents],
  ["recurring", recurring],
  ["tax", tax],
  ["payments", payments],
  ["comms", comms],
  ["portal", portal],
  ["books", books],
  ["ops", ops],
  ["team", team],
  ["platform", platform],
  ["trash", trash],
];
