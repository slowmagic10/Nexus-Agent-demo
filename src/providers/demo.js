export class DemoProvider {
  constructor() {
    this.name = "offline-demo";
    this.sequence = 0;
  }

  async complete({ messages }) {
    this.sequence += 1;
    const last = messages.at(-1);
    if (last?.role === "tool") {
      return { text: `工具已返回结果：\n\n${truncate(last.content, 900)}\n\n本轮任务完成。`, toolCalls: [] };
    }

    const input = [...messages].reverse().find((message) => message.role === "user")?.content || "";
    const call = (name, args) => ({
      text: "",
      toolCalls: [{ id: `demo-${this.sequence}`, name, arguments: args }],
    });

    const remember = input.match(/(?:记住|remember)[:：\s]*(.+)/i);
    if (remember) return call("remember", { content: remember[1] });
    const read = input.match(/(?:读取|查看|read)\s+([^\s]+\.[\w-]+)/i);
    if (read) return call("read_file", { path: read[1] });
    const search = input.match(/(?:搜索|查找|search)[:：\s]+(.+)/i);
    if (search) return call("search_files", { query: search[1], path: "." });
    const write = input.match(/(?:创建|写入|write)\s+([^\s]+)\s*(?:内容\s*[:：]?|with|为\s*[:：]?|[:：])\s*(.+)/i);
    if (write) return call("write_file", { path: write[1], content: write[2] });
    const shell = input.match(/(?:运行|执行|run)[:：\s]+(.+)/i);
    if (shell) return call("run_shell", { command: shell[1] });
    const loadSkill = input.match(/(?:加载技能|load skill)[:：\s]+([\w-]+)/i);
    if (loadSkill) return call("load_skill", { name: loadSkill[1] });
    if (/技能|skill/i.test(input)) return call("list_skills", {});
    if (/记忆|memory/i.test(input)) return call("recall_memory", { query: "" });
    if (/文件|目录|workspace|工作区/i.test(input)) return call("list_files", { path: "." });

    return {
      text: "我是离线演示模型。你可以让我查看工作区、读取文件、搜索内容、加载技能、记住信息，或尝试需要审批的写文件和 Shell 操作。输入 /help 查看示例。",
      toolCalls: [],
    };
  }
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length)}\n…（已截断）` : value;
}
