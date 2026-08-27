export class OpenAICompatibleProvider {
  constructor({ apiKey, baseUrl, model }) {
    if (!apiKey || apiKey.startsWith("REPLACE_WITH_")) {
      throw new Error("模型 API Key 尚未配置；请先填写本地环境文件中的 OPENAI_API_KEY");
    }
    this.name = `openai-compatible/${model}`;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  async complete({ systemPrompt, messages, tools, signal }) {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        ...(hasTools ? { tools, tool_choice: "auto" } : {}),
      }),
      signal,
    });

    if (!response.ok) throw new Error(`模型接口返回 ${response.status}：${await response.text()}`);
    const payload = await response.json();
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("模型接口没有返回 assistant message");

    return {
      text: message.content || "",
      finishReason: payload.choices?.[0]?.finish_reason || null,
      toolCalls: (message.tool_calls || []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
      usage: {
        inputTokens: payload.usage?.prompt_tokens || 0,
        outputTokens: payload.usage?.completion_tokens || 0,
        totalTokens: payload.usage?.total_tokens || 0,
      },
    };
  }
}

function parseArguments(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}
