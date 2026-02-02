# <img src="icon.png" width="32" height="32" valign="middle"> GyShell - AI-Native Terminal & SSH Client

![GyShell Demo](demo_imgs/demo.png)

[English](#english) | [中文](#chinese)

---

<a name="english"></a>

## 🚀 Overview
**GyShell** is a next-generation, AI-native terminal and SSH client designed for the modern developer. It doesn't just run commands; it **understands** them. By deeply integrating Large Language Models (LLMs) with a robust terminal emulator, GyShell transforms your terminal into a collaborative workspace where AI can reason, plan, and execute tasks alongside you.

## ✨ Key Features

### 1. 🤖 AI-Native Intelligence
*   **Thinking Mode**: Before execution, the Agent enters a dedicated reasoning phase to analyze complex tasks, ensuring accuracy and safety.
*   **Context Awareness**: The AI "sees" your terminal output, understands your current working directory (CWD), and can even process files you've highlighted in the UI.
*   **Token Management**: Built-in intelligent pruning ensures your long conversations stay within model limits without losing critical context.
*   **Model Compatibility**: Supports any LLM that provides an **OpenAI-compatible API**. You can easily add your own models by providing an API Key and Base URL.

### 2. 🌐 Professional Shell & SSH Client
*   **Comprehensive Shell Support**: Deeply integrated with **Zsh**, **Bash**, and **PowerShell**. It understands shell-specific behaviors and environments.
*   **Advanced SSH**: Supports password and private key authentication, SOCKS5/HTTP proxies, and complex port forwarding (Local, Remote, and Dynamic/SOCKS5 proxy).
*   **Invisible Integration**: Uses OSC (Operating System Command) markers to track command boundaries and exit codes without cluttering your screen.

### 3. 🛠️ Powerful Toolset
*   **Queue Mode**: Chain multiple AI instructions into a queue. The Agent will execute them sequentially, perfect for long-running automation tasks.
*   **MCP (Model Context Protocol)**: Dynamically extend the Agent's capabilities by connecting to any MCP-compliant server (e.g., Google Search, GitHub, Filesystem).
*   **Skills**: Create reusable, markdown-based "Skills" that provide the Agent with specialized domain knowledge or SOPs (Standard Operating Procedures).
*   **Smart File Editing**: The `create_or_edit` tool allows the AI to perform surgical string replacements instead of overwriting entire files.

### 4. 🎨 Modern User Experience
*   **Flexible Layout**: Drag-and-drop to swap panels or resize your workspace to fit your workflow.
*   **Multi-Platform Desktop App**: 
    *   **macOS**: Fully supported and frequently tested.
    *   **Windows**: Supported with basic testing.
    *   **Linux**: Build-ready (experimental, untested).
*   **Rich Media Support**: The AI can read and analyze **PDFs** and **Images** directly from your terminal environment.
*   **Command Firewall**: A built-in security layer that asks for your approval before executing potentially sensitive commands.

---

<a name="chinese"></a>

## 🚀 简介
**GyShell** 是一款为现代开发者打造的下一代 AI 原生终端与 SSH 客户端。它不仅仅是一个运行命令的工具，它更是一个能**理解**命令的助手。通过将大语言模型（LLM）与强大的终端仿真器深度融合，GyShell 将您的终端转变为一个协作工作空间，AI 可以在其中与您并肩思考、规划并执行任务。

## ✨ 核心功能

### 1. 🤖 AI 原生智能
*   **思考模式 (Thinking Mode)**：在执行任务前，Agent 会进入专门的推理阶段，分析复杂任务，确保执行的准确性与安全性。
*   **上下文感知**：AI 能“看见”您的终端输出，理解当前工作目录（CWD），甚至能处理您在 UI 中选中的高亮内容。
*   **Token 管理**：内置智能剪裁机制，确保长对话在模型限制内运行，同时不丢失关键上下文。
*   **模型兼容性**：支持所有提供 **OpenAI 兼容接口** 的大语言模型。您可以通过提供 API Key 和 Base URL 轻松添加自定义模型。

### 2. 🌐 专业级 Shell 与 SSH
*   **全方位 Shell 支持**：深度集成 **Zsh**、**Bash** 和 **PowerShell**。能够识别不同 Shell 的特性与环境变量。
*   **高级 SSH 功能**：支持密码和私钥认证、SOCKS5/HTTP 代理，以及复杂的端口转发（本地、远程及动态 SOCKS5 代理）。
*   **隐形集成**：利用 OSC（操作系统命令）标记追踪命令边界和退出码，保持终端界面整洁。

### 3. 🛠️ 强大的工具链
*   **队列模式 (Queue Mode)**：将多个 AI 指令串联进队列。Agent 将按序自动执行，非常适合长时间运行的自动化任务。
*   **MCP (模型上下文协议)**：通过连接任何符合 MCP 规范的服务器（如 Google 搜索、GitHub、文件系统），动态扩展 Agent 的能力。
*   **技能系统 (Skills)**：创建基于 Markdown 的可重用“技能”，为 Agent 提供专门的领域知识或标准作业程序（SOP）。
*   **智能文件编辑**：`create_or_edit` 工具允许 AI 进行精准的字符串替换，而非简单地覆盖整个文件。

### 4. 🎨 现代化的用户体验
*   **灵活布局**：支持拖拽交换面板位置或调整大小，随心定制您的工作流。
*   **多平台桌面应用**：
    *   **macOS**: 深度支持，经过频繁且严苛的测试。
    *   **Windows**: 支持运行，经过少量基础测试。
    *   **Linux**: 理论支持构建（实验性，尚未测试）。
*   **多模态支持**：AI 可以直接读取并分析终端环境中的 **PDF** 和 **图片**。
*   **命令防火墙**：内置安全层，在执行敏感命令前会主动请求您的授权。

---

## 📄 License / 开源协议
This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**. 
You are free to share and adapt the material, but you **must** give appropriate credit and you **may not** use the material for commercial purposes.

本项目采用 **知识共享署名-非商业性使用 4.0 国际许可协议 (CC BY-NC 4.0)**。
您可以自由地分享和修改本项目，但**必须**给出适当的署名，且**不得**将本项目用于商业目的。

---

## 🛠️ Tech Stack / 技术栈
*   **Framework**: Electron, Vite, React
*   **State Management**: MobX
*   **Terminal**: xterm.js, node-pty, ssh2
*   **AI Orchestration**: LangGraph, LangChain
*   **Styling**: Sass

---

## 📦 Installation & Build / 安装与构建
1.  Clone the repository / 克隆仓库
2.  Run `npm install` / 运行安装命令
3.  Run `npm run dev` to start development / 运行开发模式启动
4.  To build the production app / 构建生产环境应用:
    *   **macOS**: `npm run dist:mac`
    *   **Windows**: `npm run dist:win`

---

**GyShell** - *The shell that thinks with you.* / *会和你一起思考的终端。*
