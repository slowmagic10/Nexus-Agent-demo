import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

test("本地模型配置仍为占位 Key 时立即给出明确错误", () => {
  assert.throws(
    () => new OpenAICompatibleProvider({
      apiKey: "REPLACE_WITH_YOUR_DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    }),
    /API Key 尚未配置/,
  );
});
