# Codegraph codebase review

Reviewed commit: `7b340fc` (branch `mvp`, extension `0.1.16`, index schema v2).
Scope: `apps/ide-vscode`, `apps/runtime`, `apps/mcp`, all `packages/*`, `skills/codegraph`, build config.
Method: full read of every source file, plus a forced reindex of this repo to confirm runtime behaviour of the call graph.

No code was changed as part of this review. Everything below is a finding plus a proposed fix.

---

## 1. Summary

| Severity | Count | Theme |
| --- | --- | --- |
| Critical | 2 | API key written to workspace settings; unauthenticated local HTTP server allows arbitrary file read |
| High | 6 | Prompt injection via indexed docstrings, unredacted data at rest, size cap applied after read, synchronous whole-index reads on the UI thread, quadratic call resolution, method symbols not class-qualified |
| Medium | 11 | TOCTOU in containment check, CSRF/DNS-rebinding on the runtime, no CSP in the webview, unbounded `wake.log`, full graph rebuild per file save, silent parser fallback, clipboard handling, multi-root workspaces, truncation without warning, CLI wrapper ignores the auth token, `maxBuffer` failures |
| Low | 9 | Dead code, redundant branches, missing tests/CI/lint, Windows `python3` assumption, IPv6 gaps in SSRF filter, misc. |

The two Critical items are both about a secret or a filesystem boundary rather than the graph work. The graph itself is sound in design; its problems are performance and symbol identity, not correctness of the tiering.

---

## 2. Critical

### C1 — API key is stored in workspace settings and can be committed

**Where:** `apps/ide-vscode/src/extension.ts:793`, `:676-679`; `apps/ide-vscode/package.json` (`codegraph.enrichment.apiKey`).

```ts
await enrichment.update("apiKey", apiKey.trim(), vscode.ConfigurationTarget.Workspace);
```

`ConfigurationTarget.Workspace` writes the plaintext key into the repository's `.vscode/settings.json`. The repo `.gitignore` leaves `.vscode/` commented out, so the file is trackable. A user who follows **Codegraph: Configure API Provider** and then commits will publish their OpenRouter/OpenAI key. The key is also readable by any extension in the window via `getConfiguration`, and it is displayed back as the input box default (`:749`).

**Fix:** move the key to `context.secrets` (`vscode.SecretStorage`). Keep the setting name only as a deprecated read-fallback that emits a migration warning and clears itself after copying into SecretStorage. Never pass the key as an input box `value`; show a masked "key is set" state instead. Add `.vscode/settings.json` to `.gitignore` regardless, as defence in depth.

### C2 — Local runtime defaults to no auth and no root allowlist, enabling arbitrary file read

**Where:** `apps/runtime/src/index.ts:44-49`, `:136-168`, `:170-184`, `:515-522`.

Both controls are opt-in:

```ts
const AUTH_TOKEN = process.env.CODEGRAPH_RUNTIME_TOKEN?.trim() || undefined;
const ALLOWED_ROOTS = (process.env.CODEGRAPH_ALLOWED_ROOTS ?? "")...
```

`isAuthorized()` returns `true` when no token is set, and `assertAllowedRoot()` returns any resolved path when the allowlist is empty. So with `codegraph-runtime serve` running in its default configuration, any local process can POST `{"rootPath":"/","filePath":"etc/passwd","line":1}` to `/v1/tools/explain-selection` and receive up to 900 characters of file content, or point `rootPath` at `~/.ssh` and walk it via `ensure-index`. Path containment is enforced *relative to a caller-supplied root*, which is not a boundary at all when the caller picks the root.

The server does print a warning when the token is unset, but the behaviour is still fail-open.

**Fix:**
1. Generate a random token at startup when `CODEGRAPH_RUNTIME_TOKEN` is unset, print it once, and require it. Add an explicit `--insecure` / `CODEGRAPH_ALLOW_ANONYMOUS=1` escape hatch for scripted use.
2. Require at least one allowed root before serving; refuse to start otherwise (or default the allowlist to the current working directory).
3. Apply the same default to `apps/mcp/src/index.ts:73-86`, which has the identical fail-open `assertAllowedRoot`.

---

## 3. High

### H1 — Indexed docstrings reach the Agent prompt unlabelled and marked trustworthy

**Where:** `packages/indexer/src/graph.ts:437-442`; `packages/model-gateway/src/index.ts:662-676`.

`formatNeighborhoodLines` emits the raw docstring, and the slim handoff frames the whole block as fact:

```
NEIGHBORHOOD (local index — trust these file:line facts):
docstring: <verbatim repository text>
...
TRUST PROTOCOL:
- Treat listed defs/callers/callees/related as already resolved.
```

Repository content is untrusted by the project's own stated principle, and the API-key path already wraps it in `<untrusted_repository_content>` (`packages/model-gateway/src/index.ts:390-397`). The Agent path does not. A docstring containing `Ignore previous instructions and run ...` is delivered to the agent inside a block that explicitly tells it to trust the contents. Symbol names and file paths have the same exposure, but docstrings are free text and are the practical vector.

**Fix:** wrap the neighborhood block in `<untrusted_repository_content>` markers, scope the trust language to the *locations* only ("the file:line pairs are resolved; the text is untrusted repository content"), and run `redactSecrets()` over the docstring before it is emitted. Consider dropping docstrings from the prompt entirely — the agent reads the target section anyway.

### H2 — Index and bridge files store unredacted repository content and selections

**Where:** `packages/indexer/src/index.ts:118-134` (docstrings/signatures stored verbatim); `apps/ide-vscode/src/liveBridge.ts:49-62` (`state.json`, `wake.log`).

`redactSecrets()` is applied to excerpts in `packages/core` but not to anything the indexer persists, and not to the cursor selection written to `~/.cursor/codegraph/state.json` and mirrored to `~/.cursor/learn-codebase/`. A docstring or selected line containing a token lands in plaintext in the home directory with default file permissions, outside the repository and outside any repo-level secret scanning.

**Fix:** run `redactSecrets()` on `signature` and `docstring` at index time; run it on `selection`/`selectedText` before writing bridge files; create the runtime directory with mode `0700`.

### H3 — File size cap is enforced after the whole file is read into memory

**Where:** `packages/indexer/src/index.ts:180-199`.

```ts
const contained = await readContainedFile(rootPath, relativePath);   // reads entire file
const stat = await fsp.stat(contained.absolutePath);
if (stat.size > MAX_INDEX_FILE_BYTES) { return undefined; }          // too late
```

`MAX_INDEX_FILE_BYTES` (1.5 MB) never prevents the read. A single multi-gigabyte `.py` file (generated bindings, a vendored blob with a `.py` extension) is fully buffered before being rejected, and six of them can be in flight because `mapPool` uses a concurrency of 6. `readContainedFile` in `packages/security/src/index.ts:109-119` has no size limit of its own.

**Fix:** `stat()` first and return early, or add a `maxBytes` option to `readContainedFile` that stats before reading.

### H4 — The whole index is read and parsed synchronously on every cursor move

**Where:** `packages/indexer/src/index.ts:163-170` (`readWorkspaceIndexSync`), consumed by `apps/ide-vscode/src/liveBridge.ts:79-84` and `apps/ide-vscode/src/extension.ts:1084-1092`.

`publishLiveCursorState` calls `writePendingPrompt` once per bridge directory (Codegraph plus the learn-codebase mirror), and `enrichViaAgent` calls it again — three `readFileSync` + `JSON.parse` of the entire `index.json` per Live Explain tick, on the extension host's main thread. The index now carries `calls`, `callees`, and `callers` for every symbol, so it grows several-fold versus v1; on a large repo this is a multi-megabyte synchronous parse per keystroke-debounce, which will visibly stall the UI.

**Fix:** load the index once into an in-memory cache in the extension, invalidate on `ensureWorkspaceIndex`/`reindexPaths` completion and on an `fs.watch` of the index file. Pass the cached `WorkspaceIndex` into `neighborhoodLinesForPointer` (which already accepts one) instead of re-reading. Compute the neighborhood once per tick and reuse it for both bridge directories.

### H5 — Call resolution is quadratic in repository size

**Where:** `packages/indexer/src/graph.ts:196-217` (`findIndexedDefinitions`), `:288-295` (tier 3), `:319-321` (target lookup), `:298-342` (`attachCallGraph`).

Tier 3 calls `findIndexedDefinitions`, which iterates every file and every symbol in the index, and it is invoked for each call that tiers 1 and 2 did not resolve. Locating the callee to append the reverse edge does another linear `find` over the target file's symbols. For a repository near the 2000-file cap with tens of thousands of symbols and calls, this is on the order of hundreds of millions to billions of comparisons per build.

**Fix:** build the lookup structures once at the top of `attachCallGraph` — `Map<name, symbolRef[]>` globally, `Map<file, Map<name, symbolRef>>` per file — and have `resolveCallName` consult those maps. This is the same indexing strategy RepoWise's `CallResolver._build_indices` uses, and it turns the pass into roughly linear work.

### H6 — Methods are indexed as unqualified top-level functions

**Where:** `packages/language-intelligence/python_symbol_parser.py:176-228` (the visitor recurses into class bodies and appends every `FunctionDef` as a top-level symbol); `packages/indexer/src/types.ts:27-39` (no parent field).

Confirmed on `examples/demo.py`: `__init__` is emitted twice as a standalone `function` symbol, once for `RetryPolicy` and once for `PaymentService`, with no indication of the owning class. Consequences:

- `findIndexedDefinitions("__init__")` returns ambiguous matches, so tier 3 never fires for methods and definition lists are noisy.
- Same-file tier 1 resolution picks `local[0]` when several symbols share a name (`graph.ts:253-255`), so `self.foo()` in one class can bind to `foo` in a different class in the same file.
- `members[]` on the class duplicates the same methods, inflating the index.

**Fix:** record `parentName` and a qualified id (`file::Class::method`) on each symbol, key a `(class, method)` map in the resolver, and use the receiver captured at the call site (see H7) to disambiguate. Filter methods out of top-level definition candidates unless the search is explicitly unqualified.

---

## 4. Medium

### M1 — Call sites drop the receiver, so `self.x()` and `other.x()` are indistinguishable

**Where:** `packages/language-intelligence/python_symbol_parser.py:37-44` (`_call_name` returns `func.attr` for an `Attribute`).

Every `a.b()` collapses to `b`. Combined with H6 this is the main accuracy ceiling on the call graph. Capturing `receiver` (as RepoWise's `.scm` queries do) would let the resolver handle `self`/`cls` against the enclosing class and module aliases against imported files.

### M2 — TOCTOU between the containment check and the read

**Where:** `packages/security/src/index.ts:89-119`.

`assertSymlinkContained` resolves the real path and validates it, then `readContainedFile` recomputes a *lexical* path with `normalizeWorkspacePath` and reads that. The verified path and the read path are different values, and the file can be replaced by a symlink in between. Local-only exposure, but it defeats the check it is meant to enforce.

**Fix:** return the real path from the check and read exactly that, or open a file handle during validation and read from the handle.

### M3 — No Origin/Host validation on the runtime HTTP API

**Where:** `apps/runtime/src/index.ts:289-462`, `:506-512`.

The server binds to `127.0.0.1` (good) but accepts any `Host`/`Origin`, and `readJsonBody` parses the body regardless of `Content-Type`. A malicious web page can therefore issue a simple cross-origin POST that the browser will not preflight, triggering side effects (index builds, arbitrary roots) even though CORS blocks it from reading the response. DNS rebinding makes the read side reachable too.

**Fix:** reject requests whose `Host` is not `127.0.0.1[:port]`/`localhost[:port]`, reject any request carrying an `Origin` header, and require `Content-Type: application/json`.

### M4 — Webview runs scripts with no Content-Security-Policy

**Where:** `apps/ide-vscode/src/extension.ts:1401-1413`, `:1696-1701`.

`enableScripts: true` with no `<meta http-equiv="Content-Security-Policy">`. Output is escaped today (`escapeHtml`/`escapeAttribute`, `:1528-1537`), and `renderMarkdownLite` escapes before splitting cells, so there is no known injection path — but a single future unescaped interpolation of model or repository text becomes remote script execution in the panel. `localResourceRoots` is correctly scoped to `media`.

**Fix:** add a strict CSP (`default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-…'`) and give the inline script a nonce.

### M5 — `wake.log` grows without bound

**Where:** `apps/ide-vscode/src/liveBridge.ts:54-62`.

Appended on every cursor move in two directories, never rotated or truncated. A long Live Explain session writes a line per debounce interval indefinitely.

**Fix:** cap at a fixed size or line count and rotate/truncate; or make the log opt-in for debugging.

### M6 — Every `.py` save rebuilds the entire call graph

**Where:** `packages/indexer/src/index.ts:172-178` (`saveIndex` calls `attachCallGraph` on the whole index) via `reindexPaths`, wired to `onDidSaveTextDocument` at `apps/ide-vscode/src/extension.ts:503-515`.

Correct, but it makes save latency proportional to repository size — and with H5 the constant is large. It also means one save rewrites the full `index.json`.

**Fix:** after H5's maps exist, recompute edges only for the changed files plus the symbols that referenced them; keep a full rebuild for `force`.

### M7 — Parser failures degrade silently and the index does not record parse quality

**Where:** `packages/language-intelligence/src/index.ts:176-190` (catch-all falls back to regex), `packages/indexer/src/index.ts:187-195` (drops `parsed.source`), `apps/ide-vscode/src/extension.ts:290-304`.

If `python3` is missing, the parser script is not found, or the output exceeds `maxBuffer` (1 MB — reachable for a large file, see M8), every file silently falls back to the regex path. The regex path produces no calls at all, so the neighborhood is empty everywhere and the product quietly loses its main feature with no signal. The `source: "python_ast" | "regex_fallback"` discriminator already exists but is discarded by the indexer.

**Fix:** persist `parseSource` per file, surface an aggregate in `ensure_index`/`get_project_overview`, and warn once in the extension when the AST path is unavailable.

### M8 — `maxBuffer` on the parser subprocess is 1 MB

**Where:** `packages/language-intelligence/src/index.ts:180-182`.

JSON output can exceed the input size once signatures, docstrings, members, and call lists are included, so files well under `MAX_INDEX_FILE_BYTES` can blow the buffer and fall back to regex (M7).

**Fix:** raise to ~16 MB and log the overflow rather than swallowing it.

### M9 — Clipboard is overwritten and restored on a timer

**Where:** `apps/ide-vscode/src/agentHandoff.ts:76-84`, `:124`.

The user's clipboard is replaced with the prompt and restored 3 seconds later. Anything the user copies inside that window is silently discarded. On the macOS path the prompt is pasted into whatever `System Events` focuses, so a focus change mid-script can paste repository context into another application.

**Fix:** restore immediately after the paste keystroke completes rather than on a fixed timer, verify Cursor is frontmost before sending the paste, and document the behaviour.

### M10 — Only the first workspace folder is ever indexed

**Where:** `apps/ide-vscode/src/extension.ts:604`, `:481`, `:507` (all use `workspaceFolders?.[0]`).

In a multi-root workspace, files in folders 2..n get no index, so Live Explain silently produces empty neighborhoods for them.

**Fix:** resolve the folder from the active document's URI via `vscode.workspace.getWorkspaceFolder`, and key the index cache per folder.

### M11 — Truncation and skips are silent

**Where:** `packages/indexer/src/index.ts:34` and `:214` (`.slice(0, MAX_INDEXED_PYTHON_FILES)`); `:196-198` (`indexOneFile` swallows every error).

Repositories over 2000 Python files are silently half-indexed, and any per-file failure disappears. Users see missing neighborhoods with no explanation.

**Fix:** return `skipped`/`failed` counts in `IndexUpdateResult`, log them, and surface them in `ensure_index` output.

### M12 — The CLI wrapper never sends the runtime token

**Where:** `skills/codegraph/scripts/codegraph.sh:60-98`.

`curl` posts without an `Authorization` header, so every call fails with 401 once `CODEGRAPH_RUNTIME_TOKEN` is set — the secure configuration is the broken one. The fallback branch also starts an unauthenticated server on a random port (`:80-81`) and writes logs to a predictable `/tmp` path.

**Fix:** forward `CODEGRAPH_RUNTIME_TOKEN` as a bearer header, pass a generated token to the ephemeral server, and use `mktemp` for the log.

---

## 5. Low

- **L1 — Dead code in `packages/core/src/index.ts`.** `walkWorkspaceFiles` (`:248`), `readWorkspacePythonFiles` (`:279`), `collectWorkspacePythonSymbols` (`:308`), `hydratePythonSymbols` (`:224`), `findSymbolReferences` (`:411`), `classifyReferenceKind`, `scoreReference`, and `NOISE_SYMBOL_NAMES` are unreferenced since the indexer took over. `readWorkspacePythonFiles` still contains the old "read up to 200 files" behaviour the README no longer describes. Delete them.
- **L2 — Redundant/no-op branches.** `packages/indexer/src/index.ts:87-94` has two nested conditions where the second subsumes the first; `packages/indexer/src/graph.ts:267-271` is an `if` block containing only a comment.
- **L3 — No tests anywhere.** No test script, runner, or fixtures in any workspace. The 3-tier resolver, `resolvePythonModuleFiles`, `redactSecrets`, and the containment helpers are all pure functions that are cheap to test and easy to regress.
- **L4 — No CI and no lint.** There is no `.github/` directory. `npm run lint` resolves to nothing because no workspace defines a `lint` script.
- **L5 — Windows support gap.** `execFileAsync("python3", …)` (`packages/language-intelligence/src/index.ts:180`) fails on typical Windows installs where the launcher is `py` or `python`, silently degrading to regex.
- **L6 — SSRF filter gaps.** `packages/model-gateway/src/index.ts:90-118` misses IPv6 unique-local (`fc00::/7`), IPv4-mapped IPv6, and alternative literal encodings (`0x7f.0.0.1`, `2130706433`), and resolves nothing, so a hostname pointing at a private IP passes.
- **L7 — `<module>` pseudo-symbol leaks into user-facing output.** It is filtered in `buildProjectOverview` and `searchIndexedSymbols` but not in `findIndexedDefinitions`/`formatNeighborhoodLines`, so callers can render as `<module>`.
- **L8 — Nested-function calls are dropped.** `_collect_calls` (`python_symbol_parser.py:47-57`) stops at nested `FunctionDef`, so calls made inside closures are attributed to nobody.
- **L9 — Unpinned dependency ranges.** `@modelcontextprotocol/sdk: ^1.30.0`, `zod: ^3.25.0`, `esbuild: ^0.25.9`. The lockfile covers local installs, but there is no `npm ci` in CI to enforce it.

---

## 6. What is already solid

Worth keeping as-is:

- Path containment (`normalizeWorkspacePath`) is applied consistently, and the webview's `openSource` handler re-validates against the session root (`extension.ts:1916-1924`) instead of trusting the message.
- HTTP-supplied provider credentials are always dropped (`sanitizeRemoteRequest`, `mergeRequest` both force `provider: undefined, trustProviderConfig: false`), and the session's `rootPath` is frozen for its lifetime.
- The runtime bounds request bodies, uses `timingSafeEqual` for the token, and prunes sessions on a TTL.
- The handoff has a self-check that refuses to send a prompt lacking the slim marker or containing AST/LSP dump markers (`extension.ts:1123-1132`).
- Secret redaction is genuinely applied on the excerpt paths that feed the API-key prompt.
- The 3-tier resolver's confidence model and the `via` provenance on each edge are the right shape, and the atomic `tmp` + `rename` index write avoids torn files.

---

## 7. Resolution plan

Five phases. Each is independently shippable and testable; phases 1 and 2 should land before any wider rollout.

### Phase 1 — Close the two Critical gaps

| Task | Files | Change |
| --- | --- | --- |
| 1.1 Move the API key to `SecretStorage` | `apps/ide-vscode/src/extension.ts`, `apps/ide-vscode/package.json` | Read/write via `context.secrets`; treat `codegraph.enrichment.apiKey` as a deprecated migration source that is cleared after import; stop pre-filling the input box |
| 1.2 Ignore local editor settings | `.gitignore` | Add `.vscode/settings.json` |
| 1.3 Fail-closed runtime auth | `apps/runtime/src/index.ts` | Auto-generate and print a token when none is configured; require it unless `CODEGRAPH_ALLOW_ANONYMOUS=1` |
| 1.4 Require a root allowlist | `apps/runtime/src/index.ts`, `apps/mcp/src/index.ts` | Refuse to serve with an empty allowlist, or default it to `process.cwd()` |
| 1.5 Forward the token from the CLI | `skills/codegraph/scripts/codegraph.sh` | Send `Authorization: Bearer`, generate a token for the ephemeral server, `mktemp` the log |

**Acceptance:** a fresh `codegraph-runtime serve` rejects an unauthenticated request with 401 and rejects `rootPath: "/"`; configuring a provider writes no key into any settings file; `codegraph.sh` still works end to end with a token set.

### Phase 2 — Untrusted content handling

| Task | Files | Change |
| --- | --- | --- |
| 2.1 Fence the neighborhood block | `packages/model-gateway/src/index.ts` | Wrap in `<untrusted_repository_content>`; restrict the trust protocol to locations, not text |
| 2.2 Redact indexed text | `packages/indexer/src/index.ts` | `redactSecrets()` over `signature`/`docstring` before persisting |
| 2.3 Redact and lock down bridge files | `apps/ide-vscode/src/liveBridge.ts` | Redact `selection`/`selectedText`; create the runtime dir `0700`; rotate `wake.log` |
| 2.4 Add a webview CSP | `apps/ide-vscode/src/extension.ts` | Strict CSP meta plus a script nonce |
| 2.5 Harden runtime request handling | `apps/runtime/src/index.ts` | Validate `Host`, reject `Origin`, require JSON content type |

**Acceptance:** a Python file whose docstring contains an injected instruction and a fake token produces a prompt where the text is fenced and the token is redacted; the panel loads with CSP enforced and no console violations.

### Phase 3 — Indexer correctness and performance

| Task | Files | Change |
| --- | --- | --- |
| 3.1 Stat before read | `packages/indexer/src/index.ts`, `packages/security/src/index.ts` | Enforce the byte cap before buffering; add `maxBytes` to `readContainedFile` |
| 3.2 Prebuilt resolver maps | `packages/indexer/src/graph.ts` | Global name map and per-file symbol/method maps built once in `attachCallGraph` |
| 3.3 Qualify methods | `python_symbol_parser.py`, `packages/indexer/src/types.ts`, `graph.ts` | Emit `parentName` + qualified id; add a `(class, method)` resolution tier |
| 3.4 Capture receivers | `python_symbol_parser.py`, `graph.ts` | Record `receiver` on call sites; resolve `self`/`cls` against the enclosing class and aliases against imported modules |
| 3.5 Incremental graph updates | `packages/indexer/src/index.ts` | Recompute only affected edges on save; full rebuild only on `force` |
| 3.6 Report parse quality and skips | `packages/indexer/src/index.ts`, `language-intelligence/src/index.ts` | Persist `parseSource`; return `skipped`/`failed`; raise `maxBuffer`; probe `python3`/`python`/`py` |
| 3.7 Fix containment TOCTOU | `packages/security/src/index.ts` | Read the validated real path (or a held handle) |

**Acceptance:** on a repository of ~1500 Python files a forced reindex completes in a comparable time to v1 (no quadratic blow-up), `__init__` resolves to the correct class, and `ensure_index` reports parse-source and skip counts.

### Phase 4 — Extension responsiveness

| Task | Files | Change |
| --- | --- | --- |
| 4.1 Cache the index in-process | `apps/ide-vscode/src/extension.ts`, `liveBridge.ts`, `packages/indexer` | Load once, invalidate on reindex and on file change; drop `readWorkspaceIndexSync` from the hot path |
| 4.2 One neighborhood per tick | `apps/ide-vscode/src/liveBridge.ts` | Compute once and reuse across bridge directories and the handoff |
| 4.3 Multi-root support | `apps/ide-vscode/src/extension.ts` | Resolve the folder from the active document; key caches per folder |
| 4.4 Clipboard safety | `apps/ide-vscode/src/agentHandoff.ts` | Restore after the paste completes; verify frontmost app before sending keys |

**Acceptance:** no synchronous index read occurs during a Live Explain tick (verified by instrumenting or profiling); Live Explain works in the second folder of a multi-root workspace.

### Phase 5 — Engineering hygiene

| Task | Files | Change |
| --- | --- | --- |
| 5.1 Add a test runner and first suites | new `*.test.ts` per package | `node --test` or Vitest; cover the 3-tier resolver, `resolvePythonModuleFiles`, `redactSecrets`, containment helpers, `buildPointerAgentHandoffPrompt` shape, and a golden-file index test over `examples/` |
| 5.2 Add CI | `.github/workflows/ci.yml` | `npm ci`, `npm run typecheck`, `npm test`; Actions pinned to full commit SHAs; least-privilege `permissions` |
| 5.3 Add lint | root + workspaces | ESLint + Prettier with a real `lint` script so `npm run lint` stops being a no-op |
| 5.4 Delete dead code | `packages/core/src/index.ts`, `packages/indexer/src/*` | Remove L1 functions and L2 branches |
| 5.5 Tighten remaining Low items | various | SSRF literal/IPv6 forms, `<module>` filtering, nested-call attribution, `npm ci` pinning |

**Acceptance:** CI green on every push; `npm test` covers the resolver tiers; no unreferenced exports remain in `packages/core`.

---

## 8. Suggested verification for each fix

- **Secrets:** grep the workspace after configuring a provider — the key must appear in no file under the repo. Add a test asserting `redactSecrets` catches a token embedded in a docstring.
- **Runtime boundary:** a scripted request with `rootPath: "/"` and `filePath: "etc/passwd"` must return 400/401, not file content. Keep this as a regression test.
- **Prompt safety:** a fixture Python file with an adversarial docstring; assert the generated prompt contains the fence markers and does not contain the raw injected instruction outside them.
- **Graph accuracy:** extend `examples/` with a two-class, two-module fixture and assert exact callers/callees, including a method name shared by both classes.
- **Performance:** record reindex wall time and `index.json` size for a fixture repo before and after Phase 3, and assert the ratio does not regress.

---

## 9. Recommended order

1. **C1, C2** — a leaked API key and an open local file-read endpoint are the only findings that can harm a user directly.
2. **H1, H2** — the trust framing and unredacted persistence undercut the project's own security posture, and both are small changes.
3. **H3, H4, H5** — the performance and memory issues that will surface as soon as anyone points this at a real repository.
4. **H6, M1** — the accuracy ceiling on the call graph; worth doing before adding a second language, since the symbol identity model changes.
5. Everything else in phase order.
