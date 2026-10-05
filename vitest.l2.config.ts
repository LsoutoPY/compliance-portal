import { mergeConfig } from "vitest/config";
import l1 from "./vitest.l1.config.ts";

export default mergeConfig(l1, {
  test: { include: ["tests/l2/**/*.test.ts", "tests/l2/**/*.test.tsx"] },
});
