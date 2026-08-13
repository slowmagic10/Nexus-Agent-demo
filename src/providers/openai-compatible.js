export class OpenAICompatibleProvider {
  constructor({ apiKey, baseUrl, model }) {
    this.name = `openai-compatible/${model}`;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  async complete({ systemPrompt, messages, tools }) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) throw new Error(`模型接口返回 ${response.status}：${await response.text()}`);
    const payload = await response.json();
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("模型接口没有返回 assistant message");

    return {
      text: message.content || "",
      toolCalls: (message.tool_calls || []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
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
