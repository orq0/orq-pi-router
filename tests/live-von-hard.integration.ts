import { readFileSync } from "node:fs";
import {
  runLiveVonCases,
  type LiveRoutingCase,
} from "./helpers/live-von-runner.ts";

const cases = JSON.parse(
  readFileSync(
    new URL("./fixtures/high-intelligence-tasks.json", import.meta.url),
    "utf8",
  ),
) as LiveRoutingCase[];
runLiveVonCases(
  "high-intelligence tasks should select ASTRA through real Von",
  cases,
);
