import { runLiveVonCases } from "./helpers/live-von-runner.ts";

runLiveVonCases(
  "live Von routing ends at model selection, without task-model API keys",
  [
    {
      name: "Fix a typo in the documentation",
      task: "Fix a typo in the documentation",
    },
    {
      name: "Implement a pagination endpoint",
      task: "Implement a pagination endpoint",
    },
    {
      name: "Design a distributed authorization system",
      task: "Design a distributed authorization system",
    },
  ],
);
