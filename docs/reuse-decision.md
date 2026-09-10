# Reuse Decision

Decision: Borrow

## Evidence
- Project search (tool-backed anchors): existing agent-orchestrator/src/transport.mjs provides bounded length-prefixed Desktop IPC and dispatch uncertainty classification; src/store.mjs uses SqliteSaver; src/pm-engine.mjs builds bounded engineer packets. Existing pm-contract.mjs only supports three roles and offline Node fixtures, so it is not a general project controller.
- GitHub / official search (tool-backed anchors): https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE and https://github.com/tobi/qmd were read on 2026-09-11. Codex skill discovery: https://learn.chatgpt.com/docs/build-skills . The already inspected local desktop-spark-probe/native-client.mjs and REUSE.md identify https://github.com/buidangminh23/codex-mcp-bridge/tree/8cea74351c0a4d852cf1ba9f97775c4f33873d00 .
- License: LangGraph.js MIT; QMD MIT. Desktop transport retains codex-mcp-bridge's full MIT notice, Copyright 2026 Bui Dang Minh. Existing application source is the user's local work and is adapted into their private repository.
- Maintenance: pinned installed LangGraph 1.4.14, checkpoint-sqlite 1.0.4, core 1.2.10. QMD is an actively documented alternative; no QMD code or models are installed or copied in this release.
- Compatibility (contract comparison): Node 24.18.0 built-in SQLite FTS5 was executed successfully. Existing Desktop IPC envelope supplies a real caller task identity and app-owned pipe; standalone service and public stability are unverified. Native-subagent creation remains a Codex tool call and receives prepared packets, not a fabricated CLI child.
- Verification (commands/tests and observed result): node:sqlite CREATE VIRTUAL TABLE USING fts5 succeeded. New workflow integration, retrieval, restart and Desktop execution are pending their own evidence record.

## Rationale

Use one repository for one installed product. Borrow the tested Desktop transport and actual LangGraph/SQLite persistence, while replacing the old role-specific pilot contract with project-scoped tasks and common context packets. A separate supervisor LLM would duplicate the project manager.

Keep the first local RAG retriever dependency-light using SQLite FTS5/BM25 and Chinese token segmentation. QMD's optional embedding models and native model runtime add installation and resource requirements before semantic retrieval quality is measured. Basic Memory was previously reviewed as a broader writable knowledge system; it is not a dependency of this release. Keyword retrieval is explicitly documented as lexical RAG, not vector/semantic search.

## Next step

Implement and test bounded project knowledge retrieval, stable capture identity, conflict detection, route-independent packets, durable DAG dispatch and one integration acceptance. Preserve original application/runtime and old Skill copies during reversible migration. Publish only reviewed source, synthetic examples, and sanitized verification results to the new private repository.
