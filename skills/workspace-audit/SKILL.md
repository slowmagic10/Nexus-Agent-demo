---
name: workspace-audit
description: 只读检查工作区结构、规则文件与潜在风险，不进行任何修改。
---

# Workspace Audit

先读取 `AGENTS.md`，再列出顶层目录并搜索密钥、超大文件和未忽略的生成物。所有检查保持只读。输出按“发现、影响、建议”组织；没有证据时不要下结论。
