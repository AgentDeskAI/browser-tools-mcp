#!/usr/bin/env node
import { runToolsCli } from "./tools-cli.js";
import { createLogger, setLogLevel } from "./util/logger.js";

const log = createLogger("tools-cli");

runToolsCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    setLogLevel("error");
    log.error("Fatal error:", error);
    process.exit(1);
  });
