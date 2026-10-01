window.__ModuleLoader__.load({ id: "dsh-plugin-list-sync", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;

	/* eslint-disable */
	// dsh-plugin-list-sync — Client half (settings page).
	//
	// Registers a "Plugin Sync / 插件同步" section in DSH Settings:
	//   - S3 connection form (endpoint / region / bucket / prefix / path-style
	//     / insecure / include-patch-config / machine label)
	//   - Manual action buttons: Upload / Preview(diff) / Apply / Rollback
	//   - Status line with local package count + last snapshot.
	//
	// The page never touches S3 itself: every action POSTs to the host's
	// /dsh-plugin-list-sync/api/* routes, which own credentials and signing.
	// Config values persist through the standard plugin-config mechanism the
	// host already provides (the form writes them back via /api settings of
	// the harness, same-origin); where that API is unavailable the form stays
	// read-only and tells the operator to edit cordis.patch.yml.

	const NS = "dsh-plugin-list-sync";

	const DICT_ZH = {
		"nav": "插件同步",
		"title": "插件列表同步",
		"desc": "把当前客户端的插件列表配置上传到 S3 兼容存储，或在其他客户端上下载应用，实现多端一致。",
		"s3.endpoint": "S3 端点",
		"s3.endpoint.ph": "例如 https://s3.amazonaws.com 或 http://127.0.0.1:9000",
		"s3.region": "区域（Region）",
		"s3.region.ph": "AWS 填真实区域；MinIO/RustFS 可填 auto",
		"s3.bucket": "存储桶（Bucket）",
		"s3.prefix": "对象前缀（Prefix）",
		"s3.prefix.ph": "默认 dsh-plugin-list-sync",
		"s3.forcePathStyle": "Path-Style 寻址（MinIO/RustFS 需要）",
		"s3.allowInsecure": "允许明文 HTTP（不安全）",
		"s3.serverSideEncryption": "请求 SSE-S3 AES256 加密（RustFS 未配置主密钥时请关闭）",
		"cred.title": "S3 凭据（AccessKey / SecretKey）",
		"cred.accessKey": "AccessKey ID",
		"cred.secretKey": "Secret Access Key",
		"cred.status.saved": "已保存本机凭据",
		"cred.status.env": "使用环境变量凭据（DSH_PLUGIN_SYNC_S3_KEY/SECRET）",
		"cred.status.none": "未配置凭据",
		"cred.hint": "凭据保存在本机 <profile>/.dsh-plugin-list-sync/credentials.json，不会写入同步清单，也不会随插件列表上传。",
		"btn.saveCred": "保存凭据",
		"btn.clearCred": "清除已保存凭据",
		"msg.credSaved": "凭据已保存到本机。",
		"msg.credCleared": "已清除保存的凭据（如环境变量存在则回退使用）。",
		"opt.includePatchConfig": "同步 LLM provider 配置（默认关闭）",
		"opt.machineLabel": "本机标签（写入 manifest 便于识别来源）",
		"automation.title": "半自动同步（不自动应用）",
		"automation.autoUpload": "本地插件配置变化后自动上传",
		"automation.uploadDebounce": "自动上传等待秒数（3–300）",
		"automation.autoCheck": "定时检查远端更新（仅提示）",
		"automation.checkInterval": "远端检查间隔分钟（1–1440）",
		"automation.hint": "自动任务绝不会自动下载、安装、移除或应用远端插件配置；发现远端更新后请先预览差异。",
		"automation.remoteUpdate": "发现远端配置更新，请预览差异后手动应用。",
		"automation.runningUpload": "正在自动上传本地插件配置。",
		"automation.runningCheck": "正在检查远端更新。",
		"automation.error": "自动同步最近错误：{message}",
		"btn.saveSettings": "保存同步设置",
		"msg.settingsSaved": "同步设置已保存；自动任务已按新设置重配。",
		"opt.machineLabel.ph": "例如 office-desktop",
		"btn.upload": "上传当前插件列表",
		"btn.preview": "预览差异",
		"btn.apply": "下载并应用",
		"btn.rollback": "回滚",
		"btn.save": "保存配置",
		"status.title": "状态",
		"status.notConfigured": "尚未配置 S3 端点/桶。",
		"status.packages": "本地第三方插件 {n} 个",
		"status.snapshots": "可回滚快照 {n} 个",
		"plan.title": "远端差异（合并计划）",
		"plan.empty": "已同步，无差异。",
		"plan.install": "新增",
		"plan.upgrade": "升级",
		"plan.downgrade": "降级",
		"plan.remove": "移除",
		"plan.kept": "保留本地版本（远端更旧，不降级）",
		"plan.localOnly": "本地独有（合并不移除，将在下次上传时共享）",
		"plan.patch": "cordis.patch.yml 有差异",
		"plan.mergeHint": "合并语义：只新增与升级，不移除本地插件、不降级本地版本。",
		"plan.replaceHint": "强制覆盖语义：本地将完全镜像远端，以下插件会被卸载、版本会被降低。",
		"force.title": "强制覆盖（危险操作，每次需重新勾选）",
		"force.upload": "强制覆盖远端（用本机状态替换远端清单，远端独有插件会被移除）",
		"force.apply": "强制覆盖本地（用远端清单替换本地，本地独有插件会被卸载、版本可被降低）",
		"force.hint": "默认上传/下载均为安全合并。勾选后仅对下一次操作生效，操作完成自动复位，不会被保存。",
		"confirm.forceUpload": "确定要强制覆盖远端吗？\n\n远端清单中存在、但本机未安装的插件将从远端移除；远端更旧的版本也会被本机版本覆盖。\n\n此操作影响所有同步该存储的其他客户端。",
		"confirm.forceApply": "确定要强制覆盖本地吗？\n\n将卸载本地独有插件：{removals}\n将降级以下版本：{downgrades}\n\n应用前会创建快照，可回滚。",
		"confirm.none": "（无）",
		"msg.forceCancelled": "已取消强制覆盖，未做任何更改。",
		"msg.uploadedForce": "已强制上传 revision {revision}（{packages} 个插件，{bytes} 字节）——远端已被本机状态替换。",
		"msg.uploadDropped": "已从远端移除 {n} 个仅远端存在的插件：{list}",
		"err.needReplacePreview": "请先以“强制覆盖本地”勾选状态点击“预览差异”，确认移除/降级清单后再应用。",
		"msg.uploaded": "已上传 revision {revision}（{packages} 个插件，{bytes} 字节）。",
		"msg.uploadPreserved": "上传已保留 {n} 个仅存在于远端的插件：{list}",
		"msg.uploadKeptLocal": "已保留 {n} 个更高的本地版本：{list}",
		"msg.applied": "已应用远端清单（快照 {snapshot}）。",
		"msg.appliedNoop": "无差异，未做任何更改。",
		"msg.restored": "已回滚到 {snapshot}。",
		"msg.working": "处理中…",
		"err.config": "请先完成 S3 配置。",
		"err.network": "网络不可达或证书问题。",
		"err.auth": "认证失败：检查 AccessKey/SecretKey。",
		"err.notfound": "远端还没有清单：先在某一端点“上传”。",
		"err.manifest": "远端清单校验失败：{msg}",
		"err.other": "操作失败：{msg}",
		"hint.credentials": "AccessKey/SecretKey 通过环境变量 DSH_PLUGIN_SYNC_S3_KEY / DSH_PLUGIN_SYNC_S3_SECRET 提供，或存入 DSH credentials 服务；不会写入配置文件。",
		"readonly": "当前宿主不支持在线保存配置，请直接编辑 profile 的 cordis.patch.yml。",
	};

	const DICT_EN = {
		"nav": "Plugin Sync",
		"title": "Plugin List Sync",
		"desc": "Upload this client's plugin-list configuration to any S3-compatible store, or download and apply it here, keeping multiple DSH clients aligned.",
		"s3.endpoint": "S3 endpoint",
		"s3.endpoint.ph": "e.g. https://s3.amazonaws.com or http://127.0.0.1:9000",
		"s3.region": "Region",
		"s3.region.ph": "real region on AWS; auto works for MinIO/RustFS",
		"s3.bucket": "Bucket",
		"s3.prefix": "Key prefix",
		"s3.prefix.ph": "default dsh-plugin-list-sync",
		"s3.forcePathStyle": "Path-style addressing (MinIO/RustFS)",
		"s3.allowInsecure": "Allow plain HTTP (insecure)",
		"s3.serverSideEncryption": "Request SSE-S3 AES256 encryption (disable when RustFS has no master key)",
		"cred.title": "S3 credentials (AccessKey / SecretKey)",
		"cred.accessKey": "AccessKey ID",
		"cred.secretKey": "Secret Access Key",
		"cred.status.saved": "Credentials saved on this machine",
		"cred.status.env": "Using environment variables (DSH_PLUGIN_SYNC_S3_KEY/SECRET)",
		"cred.status.none": "No credentials configured",
		"cred.hint": "Stored locally in <profile>/.dsh-plugin-list-sync/credentials.json — never included in the sync manifest, never uploaded.",
		"btn.saveCred": "Save credentials",
		"btn.clearCred": "Clear saved credentials",
		"msg.credSaved": "Credentials saved locally.",
		"msg.credCleared": "Saved credentials cleared (falls back to env vars when present).",
		"opt.includePatchConfig": "Sync LLM provider config (off by default)",
		"opt.machineLabel": "Machine label (recorded in the manifest)",
		"automation.title": "Semi-automatic sync (never auto-apply)",
		"automation.autoUpload": "Automatically upload after local plugin configuration changes",
		"automation.uploadDebounce": "Auto-upload debounce seconds (3–300)",
		"automation.autoCheck": "Periodically check remote updates (notify only)",
		"automation.checkInterval": "Remote check interval minutes (1–1440)",
		"automation.hint": "Automation never downloads, installs, removes, or applies remote plugin configuration. Preview changes before applying them yourself.",
		"automation.remoteUpdate": "A remote configuration update is available; preview differences before applying.",
		"automation.runningUpload": "Automatically uploading local plugin configuration.",
		"automation.runningCheck": "Checking for remote updates.",
		"automation.error": "Latest automation error: {message}",
		"btn.saveSettings": "Save sync settings",
		"msg.settingsSaved": "Sync settings saved; automation was reconfigured.",
		"opt.machineLabel.ph": "e.g. office-desktop",
		"btn.upload": "Upload current list",
		"btn.preview": "Preview diff",
		"btn.apply": "Download && apply",
		"btn.rollback": "Rollback",
		"btn.save": "Save config",
		"status.title": "Status",
		"status.notConfigured": "S3 endpoint/bucket not configured yet.",
		"status.packages": "{n} third-party packages locally",
		"status.snapshots": "{n} rollback snapshots",
		"plan.title": "Remote differences (merge plan)",
		"plan.empty": "In sync — no differences.",
		"plan.install": "install",
		"plan.upgrade": "upgrade",
		"plan.downgrade": "downgrade",
		"plan.remove": "remove",
		"plan.kept": "kept local version (remote is older; no downgrade)",
		"plan.localOnly": "local-only (merge keeps it; shared on next upload)",
		"plan.patch": "cordis.patch.yml differs",
		"plan.mergeHint": "Merge semantics: additions and upgrades only — local plugins are never removed, local versions never downgraded.",
		"plan.replaceHint": "Force semantics: local will mirror the remote exactly — the plugins above will be uninstalled and versions lowered.",
		"force.title": "Force overwrite (dangerous; re-tick every time)",
		"force.upload": "Force overwrite REMOTE (replace the remote manifest with this machine's state; remote-only plugins are removed)",
		"force.apply": "Force overwrite LOCAL (replace local with the remote manifest; local-only plugins are uninstalled, versions may drop)",
		"force.hint": "Upload/download default to a safe merge. A tick applies to the next operation only and resets automatically; it is never saved.",
		"confirm.forceUpload": "Force overwrite the remote manifest?\n\nPlugins that exist only on the remote (not installed here) will be REMOVED from it; older remote versions will be overwritten by local ones.\n\nThis affects every client syncing this store.",
		"confirm.forceApply": "Force overwrite local?\n\nLocal-only plugins to uninstall: {removals}\nVersions to downgrade: {downgrades}\n\nA snapshot is taken first and can be rolled back.",
		"confirm.none": "(none)",
		"msg.forceCancelled": "Force overwrite cancelled; nothing was changed.",
		"msg.uploadedForce": "Force-uploaded revision {revision} ({packages} packages, {bytes} bytes) — the remote was replaced by this machine's state.",
		"msg.uploadDropped": "Removed {n} remote-only plugin(s) from the remote: {list}",
		"err.needReplacePreview": "Click \"Preview diff\" with the force tick ON first, review the removals/downgrades, then apply.",
		"msg.uploaded": "Uploaded revision {revision} ({packages} packages, {bytes} bytes).",
		"msg.uploadPreserved": "Upload preserved {n} remote-only plugin(s): {list}",
		"msg.uploadKeptLocal": "Kept {n} higher local version(s): {list}",
		"msg.applied": "Applied remote manifest (snapshot {snapshot}).",
		"msg.appliedNoop": "No differences; nothing changed.",
		"msg.restored": "Rolled back to {snapshot}.",
		"msg.working": "Working…",
		"err.config": "Complete the S3 configuration first.",
		"err.network": "Unreachable endpoint or certificate problem.",
		"err.auth": "Authentication failed: check AccessKey/SecretKey.",
		"err.notfound": "No remote manifest yet: press Upload on one client first.",
		"err.manifest": "Remote manifest rejected: {msg}",
		"err.other": "Failed: {msg}",
		"hint.credentials": "AccessKey/SecretKey come from DSH_PLUGIN_SYNC_S3_KEY / DSH_PLUGIN_SYNC_S3_SECRET env vars or the DSH credentials service; they are never written to config files.",
		"readonly": "This host cannot save config online; edit cordis.patch.yml in the profile directly.",
	};

	function fmt(t, key, params) {
		let s = t(key);
		if (typeof s !== "string") return key;
		for (const [k, v] of Object.entries(params || {})) s = s.split("{" + k + "}").join(String(v));
		return s;
	}

	function api(path) {
		const relative = path.replace(/^\/+/, "");
		if (typeof document === "undefined") return "/" + relative;
		return new URL(relative, document.baseURI).pathname;
	}

	const name = "dsh-plugin-list-sync";
	const inject = ["slots", "locale"];

	function apply(ctx) {
		let t = (key) => key;
		ctx.effect(function registerDict() {
			const off = ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
			t = ctx.locale.bind(NS);
			return off;
		}, "dsh-plugin-list-sync: dictionaries");

		// React through the host module table — never bundled.
		const react = require("react");
		const h = react.createElement;

		/** ---------- tiny presentational helpers (host-primitive-free) ---------- */

		function Field(props) {
			return h("label", { style: { display: "block", margin: "10px 0" } },
				h("div", { style: { fontWeight: 500, marginBottom: 4 } }, props.label),
				props.children,
				props.hint ? h("div", { style: { opacity: 0.65, fontSize: 12, marginTop: 2 } }, props.hint) : null,
			);
		}

		function inputStyle() {
			return {
				width: "100%", boxSizing: "border-box", padding: "6px 8px",
				borderRadius: 6, border: "1px solid var(--dsh-border, #8886)",
				background: "var(--dsh-input-bg, transparent)", color: "inherit", fontSize: 13,
			};
		}

		function btnStyle(kind) {
			const base = { padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, border: "1px solid var(--dsh-border, #8886)" };
			if (kind === "primary") return { ...base, fontWeight: 600 };
			if (kind === "danger") return { ...base, opacity: 0.9 };
			return base;
		}

		/** ---------- state ---------- */

		const FORM_STORAGE_KEY = "dsh-plugin-list-sync.form";

		function loadStoredForm() {
			try {
				const raw = localStorage.getItem(FORM_STORAGE_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch { return {}; }
		}

		const state = {
			form: Object.assign({
				endpoint: "", region: "auto", bucket: "", prefix: "dsh-plugin-list-sync",
				forcePathStyle: true, allowInsecure: false, serverSideEncryption: false,
				includePatchConfig: false, machineLabel: "",
				autoUpload: false, uploadDebounceSeconds: 8,
				autoCheck: false, checkIntervalMinutes: 15,
			}, loadStoredForm()),
			status: null, plan: null, busy: false, message: null, error: null, snapshots: [],
			credentials: { source: null, accessKeyIdMasked: undefined },
			automation: null,
			settingsLoaded: false,
			cred: { accessKeyId: "", secretAccessKey: "" },
			// Deliberately NOT persisted (never in state.form, never in
			// localStorage, never in settings.json): force actions are
			// per-operation decisions that must be re-ticked every time.
			forceUpload: false,
			forceApply: false,
		};

		function setForm(patch) {
			Object.assign(state.form, patch);
			try { localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(state.form)); } catch { /* private mode */ }
			render();
		}

		/** The exact payload the host's mergedConfig expects: s3 block nested. */
		function s3Payload() {
			const f = state.form;
			return {
				s3: {
					endpoint: f.endpoint, region: f.region, bucket: f.bucket, prefix: f.prefix,
					forcePathStyle: f.forcePathStyle, allowInsecure: f.allowInsecure,
					serverSideEncryption: f.serverSideEncryption === true,
				},
				includePatchConfig: f.includePatchConfig,
				machineLabel: f.machineLabel,
				automation: {
					autoUpload: f.autoUpload === true,
					uploadDebounceSeconds: Number(f.uploadDebounceSeconds),
					autoCheck: f.autoCheck === true,
					checkIntervalMinutes: Number(f.checkIntervalMinutes),
				},
			};
		}

		function formConfigured() {
			return state.form.endpoint.trim() !== "" && state.form.bucket.trim() !== "";
		}

		function adoptSettings(settings) {
			if (settings === null || typeof settings !== "object") return;
			const s3 = settings.s3 && typeof settings.s3 === "object" ? settings.s3 : {};
			const automation = settings.automation && typeof settings.automation === "object" ? settings.automation : {};
			Object.assign(state.form, s3, {
				includePatchConfig: settings.includePatchConfig === true,
				machineLabel: typeof settings.machineLabel === "string" ? settings.machineLabel : "",
				autoUpload: automation.autoUpload === true,
				uploadDebounceSeconds: automation.uploadDebounceSeconds ?? 8,
				autoCheck: automation.autoCheck === true,
				checkIntervalMinutes: automation.checkIntervalMinutes ?? 15,
			});
			try { localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(state.form)); } catch { /* private mode */ }
		}

		async function doSaveSettings() {
			const data = await call("/dsh-plugin-list-sync/api/config", { settings: s3Payload() }, "PUT");
			if (data === null) return;
			state.settingsLoaded = true;
			if (data.settings !== undefined) adoptSettings(data.settings);
			if (data.automation !== undefined) state.automation = data.automation;
			setMessage(t("msg.settingsSaved"));
			refreshStatus();
		}
		/** Controlled-input setter for the credentials fields: mutate + re-render,
		 *  exactly like setForm — without the render() call React snaps the value
		 *  back on every keystroke and the field looks untypeable/unpasteable. */
		function setCred(patch) { Object.assign(state.cred, patch); render(); }
		function setMessage(m) { state.message = m; state.error = null; render(); }
		function setError(code, msgText) {
			const map = { config: "err.config", network: "err.network", auth: "err.auth", "not-found": "err.notfound", manifest: "err.manifest" };
			const key = map[code] ?? "err.other";
			state.error = fmt(t, key, { msg: msgText });
			state.message = null; render();
		}

		async function call(path, body, method) {
			state.busy = true; state.error = null; state.message = fmt(t, "msg.working"); render();
			try {
				const res = await fetch(api(path), {
					method: method ?? "POST", cache: "no-store", headers: { "content-type": "application/json" },
					body: method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
				});
				const data = await res.json();
				state.busy = false;
				// Successful callers render a result (preview) or a completion message
				// (upload/apply/rollback). Remove the transient loading text first so
				// preview does not misleadingly remain at “处理中…”.
				state.message = null;
				if (!res.ok || data.ok === false) {
					setError(data?.error?.code ?? "other", data?.error?.message ?? String(res.status));
					return null;
				}
				return data;
			} catch (e) {
				state.busy = false;
				setError("network", String(e?.message ?? e));
				return null;
			}
		}

		async function refreshStatus() {
			try {
				const res = await fetch(api("/dsh-plugin-list-sync/api/status"), { cache: "no-store" });
				const data = await res.json();
				if (data.ok === true) {
					state.status = data; state.snapshots = data.snapshots ?? [];
					if (data.credentials !== undefined) state.credentials = data.credentials;
					if (data.automation !== undefined) state.automation = data.automation;
					if (!state.settingsLoaded && data.settings !== null && data.settings !== undefined) {
						adoptSettings(data.settings);
						state.settingsLoaded = true;
					}
					render();
				}
			} catch { /* status is decorative */ }
		}

		async function doSaveCredentials() {
			const data = await call("/dsh-plugin-list-sync/api/credentials", {
				accessKeyId: state.cred.accessKeyId.trim(),
				secretAccessKey: state.cred.secretAccessKey.trim(),
			}, "PUT");
			if (data === null) return;
			state.cred.accessKeyId = ""; state.cred.secretAccessKey = "";
			state.credentials = { source: data.source, accessKeyIdMasked: data.accessKeyIdMasked };
			setMessage(t("msg.credSaved"));
			refreshStatus();
		}

		async function doClearCredentials() {
			const data = await call("/dsh-plugin-list-sync/api/credentials", null, "DELETE");
			if (data === null) return;
			state.credentials = { source: data.source, accessKeyIdMasked: undefined };
			setMessage(t("msg.credCleared"));
			refreshStatus();
		}

		/** ---------- panel ---------- */

		function Panel() {
			const form = state.form;
			const statusContent = state.status === null
				? "…"
				: (state.status.configured || formConfigured())
					? [
						h("span", { key: "p" }, fmt(t, "status.packages", { n: state.status?.local?.packages ?? "?" }), " · "),
						h("span", { key: "s" }, fmt(t, "status.snapshots", { n: state.status?.snapshots?.length ?? 0 })),
					]
					: h("span", null, t("status.notConfigured"));
			const automation = state.automation;
			const automationNotice = automation?.remoteUpdateAvailable
				? h("div", { style: { margin: "8px 0", color: "var(--dsh-warn, #a65f00)", fontSize: 13 } }, t("automation.remoteUpdate"))
				: automation?.uploadRunning
					? h("div", { style: { margin: "8px 0", fontSize: 13 } }, t("automation.runningUpload"))
					: automation?.checkRunning
						? h("div", { style: { margin: "8px 0", fontSize: 13 } }, t("automation.runningCheck"))
						: automation?.lastAutoError
							? h("div", { style: { margin: "8px 0", color: "var(--dsh-err, #c33)", fontSize: 13 } }, fmt(t, "automation.error", { message: automation.lastAutoError.message }))
							: null;
			return h("div", { style: { padding: "4px 0", fontSize: 13, lineHeight: 1.5 } },
				h("h3", { style: { margin: "0 0 4px" } }, t("title")),
				h("p", { style: { opacity: 0.75, marginTop: 0 } }, t("desc")),

				// status line — local form values count before loader config persists.
				h("div", { style: { margin: "8px 0", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--dsh-border, #8884)" } },
					h("strong", null, t("status.title"), " · "),
					statusContent),
				automationNotice,

				// S3 connection form
				h(Field, { label: t("s3.endpoint") },
					h("input", { style: inputStyle(), placeholder: t("s3.endpoint.ph"), value: form.endpoint, onInput: (e) => setForm({ endpoint: e.target.value }) })),
				h(Field, { label: t("s3.region"), hint: null },
					h("input", { style: inputStyle(), placeholder: t("s3.region.ph"), value: form.region, onInput: (e) => setForm({ region: e.target.value }) })),
				h(Field, { label: t("s3.bucket") },
					h("input", { style: inputStyle(), value: form.bucket, onInput: (e) => setForm({ bucket: e.target.value }) })),
				h(Field, { label: t("s3.prefix") },
					h("input", { style: inputStyle(), placeholder: t("s3.prefix.ph"), value: form.prefix, onInput: (e) => setForm({ prefix: e.target.value }) })),
				h(Field, { label: t("s3.forcePathStyle") },
					h("input", { type: "checkbox", checked: form.forcePathStyle, onChange: (e) => setForm({ forcePathStyle: e.target.checked }) })),
				h(Field, { label: t("s3.allowInsecure") },
					h("input", { type: "checkbox", checked: form.allowInsecure, onChange: (e) => setForm({ allowInsecure: e.target.checked }) })),
				h(Field, { label: t("s3.serverSideEncryption") },
					h("input", { type: "checkbox", checked: form.serverSideEncryption === true, onChange: (e) => setForm({ serverSideEncryption: e.target.checked }) })),

				// credentials block
				h("div", { style: { margin: "12px 0 4px", padding: "10px", borderRadius: 8, border: "1px solid var(--dsh-border, #8884)" } },
					h("div", { style: { fontWeight: 600, marginBottom: 6 } }, t("cred.title")),
					state.credentials.source !== null
						? h("div", { style: { opacity: 0.8, fontSize: 12, marginBottom: 6 } },
							t("cred.status." + state.credentials.source)
							+ (state.credentials.accessKeyIdMasked ? " · " + state.credentials.accessKeyIdMasked : ""))
						: h("div", { style: { opacity: 0.7, fontSize: 12, marginBottom: 6 } }, t("cred.status.none")),
					h(Field, { label: t("cred.accessKey") },
						h("input", { style: inputStyle(), autoComplete: "off", placeholder: "AKIA…", value: state.cred.accessKeyId, onInput: (e) => setCred({ accessKeyId: e.target.value }) })),
					h(Field, { label: t("cred.secretKey") },
						h("input", { style: inputStyle(), type: "password", autoComplete: "new-password", placeholder: "••••••", value: state.cred.secretAccessKey, onInput: (e) => setCred({ secretAccessKey: e.target.value }) })),
					h("div", { style: { display: "flex", gap: 8, margin: "6px 0 0" } },
						h("button", { style: btnStyle("primary"), disabled: state.busy, onClick: doSaveCredentials }, t("btn.saveCred")),
						state.credentials.source === "saved"
							? h("button", { style: btnStyle("danger"), disabled: state.busy, onClick: doClearCredentials }, t("btn.clearCred"))
							: null),
					h("div", { style: { opacity: 0.65, fontSize: 12, marginTop: 6 } }, t("cred.hint")),
				),

				h(Field, { label: t("opt.includePatchConfig") },
					h("input", { type: "checkbox", checked: form.includePatchConfig, onChange: (e) => setForm({ includePatchConfig: e.target.checked }) })),
				h(Field, { label: t("opt.machineLabel") },
					h("input", { style: inputStyle(), placeholder: t("opt.machineLabel.ph"), value: form.machineLabel, onInput: (e) => setForm({ machineLabel: e.target.value }) })),

				h("div", { style: { margin: "14px 0 6px", padding: "10px", borderRadius: 8, border: "1px solid var(--dsh-border, #8884)" } },
					h("div", { style: { fontWeight: 600, marginBottom: 6 } }, t("automation.title")),
					h(Field, { label: t("automation.autoUpload") },
						h("input", { type: "checkbox", checked: form.autoUpload === true, onChange: (e) => setForm({ autoUpload: e.target.checked }) })),
					h(Field, { label: t("automation.uploadDebounce") },
						h("input", { style: inputStyle(), type: "number", min: 3, max: 300, value: form.uploadDebounceSeconds, onInput: (e) => setForm({ uploadDebounceSeconds: e.target.value }) })),
					h(Field, { label: t("automation.autoCheck") },
						h("input", { type: "checkbox", checked: form.autoCheck === true, onChange: (e) => setForm({ autoCheck: e.target.checked }) })),
					h(Field, { label: t("automation.checkInterval") },
						h("input", { style: inputStyle(), type: "number", min: 1, max: 1440, value: form.checkIntervalMinutes, onInput: (e) => setForm({ checkIntervalMinutes: e.target.value }) })),
					h("button", { style: btnStyle("primary"), disabled: state.busy, onClick: doSaveSettings }, t("btn.saveSettings")),
					h("div", { style: { opacity: 0.7, fontSize: 12, marginTop: 6 } }, t("automation.hint")),
				),

				// force-overwrite switches — one-shot, never persisted
				h("div", { style: { margin: "14px 0 6px", padding: "10px", borderRadius: 8, border: "1px solid var(--dsh-err, #c33)" + "" } },
					h("div", { style: { fontWeight: 600, marginBottom: 6, color: "var(--dsh-err, #c33)" } }, t("force.title")),
					h(Field, { label: t("force.upload") },
						h("input", { type: "checkbox", checked: state.forceUpload === true, onChange: (e) => { state.forceUpload = e.target.checked; render(); } })),
					h(Field, { label: t("force.apply") },
						h("input", { type: "checkbox", checked: state.forceApply === true, onChange: (e) => { state.forceApply = e.target.checked; render(); } })),
					h("div", { style: { opacity: 0.7, fontSize: 12, marginTop: 6 } }, t("force.hint")),
				),

				// actions
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0 6px" } },
					h("button", { style: btnStyle(), disabled: state.busy, onClick: doPreview }, t("btn.preview")),
					h("button", { style: btnStyle(state.forceUpload ? "danger" : "primary"), disabled: state.busy, onClick: doUpload }, t("btn.upload")),
					h("button", { style: btnStyle(state.forceApply ? "danger" : "primary"), disabled: state.busy, onClick: doApply }, t("btn.apply")),
					state.snapshots.length > 0
						? h("button", { style: btnStyle("danger"), disabled: state.busy, onClick: doRollback }, t("btn.rollback") + " (" + state.snapshots[0].id.slice(0, 26) + "…)")
						: null,
				),

				// plan preview
				state.plan !== null
					? h("div", { style: { margin: "8px 0", padding: "8px 10px", borderRadius: 8, border: "1px dashed var(--dsh-border, #8886)" } },
						h("strong", null, t("plan.title")),
						h("pre", { style: { margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: 12 } }, planText(state.plan)))
					: null,

				// messages
				state.message !== null ? h("div", { style: { color: "var(--dsh-ok, #2a7)", marginTop: 8 } }, state.message) : null,
				state.error !== null ? h("div", { style: { color: "var(--dsh-err, #c33)", marginTop: 8 } }, state.error) : null,
			);
		}

		function planText(plan) {
			if (plan.empty) return t("plan.empty");
			const replace = plan.mode === "replace";
			const lines = [];
			for (const e of plan.installs ?? []) lines.push("+ " + e.name + "@" + e.version);
			for (const e of plan.upgrades ?? []) lines.push("↑ " + e.name + " " + e.from + " → " + e.to);
			if (replace) {
				for (const e of plan.downgrades ?? []) lines.push("↓ " + e.name + " " + e.from + " → " + e.to);
				for (const e of plan.removals ?? []) lines.push("✗ " + e.name + " — " + t("plan.remove"));
			} else {
				for (const e of plan.keptLocal ?? []) lines.push("= " + e.name + " " + e.local + " (" + fmt(t, "plan.kept", { remote: e.remote }) + ")");
				for (const e of plan.localOnly ?? []) lines.push("• " + e.name + "@" + e.version + " — " + t("plan.localOnly"));
			}
			if (plan.patchDiffers) lines.push("~ " + t("plan.patch"));
			lines.push("");
			lines.push(replace ? t("plan.replaceHint") : t("plan.mergeHint"));
			return lines.join("\n");
		}

		async function doUpload() {
			if (!formConfigured()) { setError("config", ""); render(); return; }
			if (state.forceUpload && !window.confirm(t("confirm.forceUpload"))) {
				setMessage(t("msg.forceCancelled"));
				return;
			}
			const data = await call("/dsh-plugin-list-sync/api/upload", { config: s3Payload(), force: state.forceUpload === true });
			// One-shot: whatever the outcome, the force tick resets so the next
			// upload is a safe merge unless the user opts in again.
			state.forceUpload = false;
			render();
			if (data === null) return;
			let message = fmt(t, "msg.uploaded", { revision: data.revision, packages: data.packages, bytes: data.bytes });
			if (data.force === true) message = fmt(t, "msg.uploadedForce", { revision: data.revision, packages: data.packages, bytes: data.bytes });
			if (Array.isArray(data.preservedRemotePackages) && data.preservedRemotePackages.length > 0) {
				message += " " + fmt(t, "msg.uploadPreserved", { n: data.preservedRemotePackages.length, list: data.preservedRemotePackages.join(", ") });
			}
			if (Array.isArray(data.keptLocalVersions) && data.keptLocalVersions.length > 0) {
				message += " " + fmt(t, "msg.uploadKeptLocal", { n: data.keptLocalVersions.length, list: data.keptLocalVersions.join(", ") });
			}
			if (Array.isArray(data.droppedRemotePackages) && data.droppedRemotePackages.length > 0) {
				message += " " + fmt(t, "msg.uploadDropped", { n: data.droppedRemotePackages.length, list: data.droppedRemotePackages.join(", ") });
			}
			setMessage(message);
			refreshStatus();
		}

		async function doPreview() {
			if (!formConfigured()) { setError("config", ""); render(); return; }
			const data = await call("/dsh-plugin-list-sync/api/preview", { config: s3Payload(), mode: state.forceApply === true ? "replace" : "merge" });
			if (data === null) return;
			state.plan = data.plan; render();
			refreshStatus();
		}

		async function doApply() {
			if (!formConfigured()) { setError("config", ""); render(); return; }
			const replace = state.forceApply === true;
			if (replace) {
				// Guard 1: the currently displayed plan must be the replace plan.
				if (state.plan?.mode !== "replace") {
					setError("confirm-required", t("err.needReplacePreview"));
					return;
				}
				// Guard 2: explicit confirmation spelling out the destructive parts.
				const removals = (state.plan.removals ?? []).map((e) => e.name);
				const downgrades = (state.plan.downgrades ?? []).map((e) => e.name + " " + e.from + " → " + e.to);
				if (!window.confirm(fmt(t, "confirm.forceApply", {
					removals: removals.length > 0 ? removals.join(", ") : t("confirm.none"),
					downgrades: downgrades.length > 0 ? downgrades.join(", ") : t("confirm.none"),
				}))) {
					setMessage(t("msg.forceCancelled"));
					return;
				}
			}
			const payload = replace
				? { config: s3Payload(), mode: "replace", confirmReplace: true }
				: { config: s3Payload(), mode: "merge" };
			const data = await call("/dsh-plugin-list-sync/api/apply", payload);
			// One-shot: the force tick never survives an apply attempt.
			state.forceApply = false;
			render();
			if (data === null) return;
			state.plan = data.plan ?? state.plan;
			setMessage(data.applied ? fmt(t, "msg.applied", { snapshot: data.snapshotId }) : t("msg.appliedNoop"));
			refreshStatus();
		}

		async function doRollback() {
			const snap = state.snapshots[0];
			if (!snap) return;
			const data = await call("/dsh-plugin-list-sync/api/rollback", { snapshotId: snap.id });
			if (data === null) return;
			setMessage(fmt(t, "msg.restored", { snapshot: data.restored }));
			refreshStatus();
		}

		/** ---------- rendering loop (no framework store; the settings section re-mounts us) ---------- */

		let mountPoint = null;
		function render() {
			if (mountPoint === null) return;
			react_dom_root_render(mountPoint, h(Panel));
		}
		function react_dom_root_render(container, element) {
			// The settings section gives us a plain DOM node; render with
			// react-dom from the host module table.
			const reactDom = require("react-dom");
			if (typeof reactDom.createRoot === "function") {
				if (!container.__dshPlsRoot) container.__dshPlsRoot = reactDom.createRoot(container);
				container.__dshPlsRoot.render(element);
			} else {
				reactDom.render(element, container);
			}
		}

		ctx.slots.inject("settings.section", () => {
			const off = ctx.slots.register({
				name: "settings.section",
				id: "dsh-plugin-list-sync",
				order: 45,
				label: () => t("nav"),
				locale: NS,
			}, (ownerProps = {}) => {
				const ref = react.useRef(null);
				react.useEffect(() => {
					mountPoint = ref.current;
					render();
					refreshStatus();
					return () => { mountPoint = null; };
				}, []);
				return h("div", { ref, style: { maxWidth: 640 } });
			});
			return typeof off === "function" ? off : () => {};
		});
	}

	module.exports = { name, inject, apply };
	return module.exports;
}});
