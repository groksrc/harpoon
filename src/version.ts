import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

/** Version information for Harpoon. */
export const VERSION: string = pkg.version;
