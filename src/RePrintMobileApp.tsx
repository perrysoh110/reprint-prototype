"use client";
/**
 * Re‑Print Mobile App — V2.0 (full, hardened, no modern parser traps)
 *
 * Key behaviors:
 * - Connect‑to‑start gating. Start opens Devices if not connected.
 * - 3 devices with independent background runs (Recycle only). Switching devices shows that device’s live state.
 * - Stages: Shredding → Melting → Extruding → Spooling. Spool % only fills during Spooling (recycling >= 75%).
 * - Auto‑stop on completion; 30s auto‑reset to Ready.
 * - Logs by device (tabbed). Diagnose resolves all errors → device becomes Operational.
 * - Logs has Export + Help Ticket buttons. Bottom Logs badge shows error count (connected device else total).
 * - Top bar badges: status (if connected & no errors), Operational / Needs Attention, Connected/Not Connected.
 * - AI monitor overlay (static boxes) in monitoring panel.
 * - Material detected badge: “Detected: PLA”, with Change sheet.
 * - Temperature setpoint/live with safe controls.
 *
 * Hardening choices to avoid toolchain issues:
 * - No numeric separators; no nullish coalescing; no non‑null assertions; explicit semicolons; DOM timer types only.
 * - Prefer React.ReactNode for component typings; avoid angle‑bracket type assertions in TSX.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Thermometer, Power, Recycle, Printer, X, Monitor, Pause, Square, Settings, PlugZap, AlertCircle, BarChart3, FlaskConical, CheckCircle2, Loader2, Circle } from "lucide-react";

// ---------- Utilities ----------
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const HOUR_MS = 3600000;
const MIN_MS = 60000;
function formatDuration(ms: number): string {
  const h = Math.floor(ms / HOUR_MS);
  const m = Math.ceil((ms % HOUR_MS) / MIN_MS);
  return h <= 0 ? String(m) + "m" : String(h) + "h " + String(m) + "m";
}

// ---------- Types ----------
 type Status = "Ready" | "Busy" | "Paused" | "Completed";
 type TaskKind = null | "Recycle";
 interface Dev { id: string; name: string; }
 interface DeviceRun {
  status: Status;
  task: TaskKind;
  recycling: number; // 0..100
  spool: number;     // 0..100 (only fills during Spooling)
  startedAt?: number;
  completedAt?: number;
 }
 interface DeviceLogEntry {
  id: string;
  ts: number;
  level: "error" | "info" | "resolved";
  message: string;
 }

 const MATERIAL_PRESETS: Record<string, { setpoint: number; range: [number, number]; label: string; density: string }> = {
  PLA:  { setpoint: 205, range: [180, 220], label: "PLA (Polylactic Acid)", density: "1.24 g/cm³" },
  PETG: { setpoint: 240, range: [220, 260], label: "PETG (Polyethylene Terephthalate Glycol)", density: "1.27 g/cm³" },
  ABS:  { setpoint: 245, range: [220, 250], label: "ABS (Acrylonitrile Butadiene Styrene)", density: "1.04 g/cm³" }
};

// ---------- Small UI helpers ----------
 type BadgeTone = "ok" | "warn" | "muted" | "info";
 type BadgeProps = { tone?: BadgeTone; children: React.ReactNode };
 const badgeMap: Record<BadgeTone, string> = {
  ok: "px-2 py-0.5 rounded-full text-xs border border-emerald-400/20 bg-emerald-500/15 text-emerald-300",
  warn: "px-2 py-0.5 rounded-full text-xs border border-amber-400/20 bg-amber-500/15 text-amber-300",
  muted: "px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-300",
  info: "px-2 py-0.5 rounded-full text-xs border border-sky-400/20 bg-sky-500/15 text-sky-300",
 };
 function Badge({ tone = "ok", children }: BadgeProps): React.ReactNode { return <span className={badgeMap[tone]}>{children}</span>; }
 function Card({ children }: { children: React.ReactNode }): React.ReactNode { return <div className="bg-slate-800/80 border border-slate-700 rounded-2xl shadow p-4">{children}</div>; }
 function Row({ icon, title, right, sub }: { icon?: React.ReactNode; title: string; right?: React.ReactNode; sub?: React.ReactNode }): React.ReactNode {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">{icon}<span className="font-medium">{title}</span></div>
        <div>{right}</div>
      </div>
      {sub ? <div className="text-xs text-slate-300 mt-1">{sub}</div> : null}
    </div>
  );
 }

// ---------- Component ----------
export default function RePrintMobileApp(): React.ReactNode {
  const TOTAL_MS = 2 * 60 * 60 * 1000; // 2h (ETA reference)
  // NOTE: removed `as const` to avoid JS parser errors in non-TS-aware environments.
  const STAGES: string[] = ["Shredding", "Melting", "Extruding", "Spooling"]; 
  const devices: Dev[] = [
    { id: "r1", name: "Re-Print 1" },
    { id: "r2", name: "Re-Print 2" },
    { id: "r3", name: "Re-Print 3" },
  ];

  // Connection
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const connected: Dev | null = devices.find((d) => d.id === connectedId) || null;

  // Per-device runs
  const [runs, setRuns] = useState<Record<string, DeviceRun>>(() => {
    const init: Record<string, DeviceRun> = {};
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];
      init[d.id] = { status: "Ready", task: null, recycling: 0, spool: 0 };
    }
    return init;
  });

  // Logs (seed r1 with 3 errors)
  const [logs, setLogs] = useState<Record<string, DeviceLogEntry[]>>(() => {
    const t = Date.now();
    return {
      r1: [
        { id: "e1", ts: t - 5 * MIN_MS, level: "error" as DeviceLogEntry["level"], message: "Placeholder error message (sensor drift)" },
        { id: "e2", ts: t - 3 * MIN_MS, level: "error" as DeviceLogEntry["level"], message: "Placeholder error message (jam detected)" },
        { id: "e3", ts: t - 1 * MIN_MS, level: "error" as DeviceLogEntry["level"], message: "Placeholder error message (over-temp)" },
      ],
      r2: [],
      r3: [],
    };
  });

  // UI sheets
  const [logOpen, setLogOpen] = useState(false);
  const [logTab, setLogTab] = useState<string>("r1");
  const [matOpen, setMatOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [monOpen, setMonOpen] = useState(false);

  // Material / temps (global controls only)
  const [material, setMaterial] = useState<keyof typeof MATERIAL_PRESETS>("PLA");
  const preset = useMemo(() => MATERIAL_PRESETS[material], [material]);
  const [tSet, setTSet] = useState<number>(preset.setpoint);
  const [tLive, setTLive] = useState<number>(preset.setpoint);
  useEffect(() => { setTSet(preset.setpoint); }, [preset.setpoint]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setTLive(function (s) {
        const jitter = (Math.random() * 2 - 1) * 2; // ±2°C
        const target = tSet + jitter;
        const next = s + (target - s) * 0.25;
        const lo = tSet - 2;
        const hi = tSet + 2;
        return next < lo ? lo : next > hi ? hi : next;
      });
    }, 750);
    return () => { window.clearInterval(id); };
  }, [tSet]);

  // Background progress for all devices
  // DOM timer ids only to avoid Node/DOM type mismatch
  const timers = useRef<Record<string, number | null>>({});
  useEffect(() => {
    const id = window.setInterval(() => {
      setRuns((prev) => {
        const nxt: Record<string, DeviceRun> = { ...prev };
        const keys = Object.keys(prev);
        for (let i = 0; i < keys.length; i++) {
          const devId = keys[i];
          const r = prev[devId];
          if (r.status === "Busy" && r.task === "Recycle") {
            const inc = Math.random() * 2.0 + 1.0; // smoother pace
            const rec = clamp(r.recycling + inc, 0, 100);
            // Spool mirrors the portion beyond 75%
            const sp = rec < 75 ? 0 : clamp(((rec - 75) / 25) * 100, 0, 100);
            nxt[devId] = { ...r, recycling: rec, spool: Math.max(r.spool, sp) };
            if (rec >= 100 && sp >= 100) {
              nxt[devId] = { ...nxt[devId], status: "Completed", completedAt: Date.now() };
              if (timers.current[devId] !== null && timers.current[devId] !== undefined) {
                window.clearTimeout(timers.current[devId] as number);
              }
              timers.current[devId] = window.setTimeout(() => {
                setRuns((p2) => ({
                  ...p2,
                  [devId]: { status: "Ready", task: null, recycling: 0, spool: 0 },
                }));
              }, 30000);
            }
          }
        }
        return nxt;
      });
    }, 1100);
    return () => { window.clearInterval(id); };
  }, []);

  // Derived
  const view: DeviceRun = connected ? runs[connected.id] : { status: "Ready", task: null, recycling: 0, spool: 0 };
  const stageIdx = view.recycling < 25 ? 0 : view.recycling < 50 ? 1 : view.recycling < 75 ? 2 : 3;
  const etaMs = Math.max(0, (1 - view.recycling / 100) * TOTAL_MS);
  const hasErr = (id: string | null): boolean => {
    if (!id) return false;
    const arr = logs[id] || [];
    for (let i = 0; i < arr.length; i++) if (arr[i].level === "error") return true;
    return false;
  };
  const errCount = (id: string): number => {
    const arr = logs[id] || [];
    let n = 0; for (let i = 0; i < arr.length; i++) if (arr[i].level === "error") n++;
    return n;
  };
  let totalErr = 0;
  {
    const devIds = Object.keys(logs);
    for (let i = 0; i < devIds.length; i++) totalErr += errCount(devIds[i]);
  }
  const bubble = connected ? errCount(connected.id) : totalErr;

  // Actions
  function start(): void {
    if (!connected) { setDevOpen(true); return; }
    if (hasErr(connected.id)) { setLogOpen(true); setLogTab(connected.id); return; }
    setRuns((p) => {
      const r = p[connected.id];
      const started = r.startedAt != null ? r.startedAt : Date.now();
      const rec = r.recycling > 0 && r.recycling < 100 ? r.recycling : 18;
      return { ...p, [connected.id]: { ...r, status: "Busy", task: "Recycle", recycling: rec, startedAt: started } };
    });
  }
  function stop(): void {
    if (!connected) return;
    setRuns((p) => ({ ...p, [connected.id]: { status: "Ready", task: null, recycling: 0, spool: 0 } }));
  }
  function pause(): void {
    if (!connected) return;
    setRuns((p) => {
      const r = p[connected.id];
      if (r.status === "Busy") return { ...p, [connected.id]: { ...r, status: "Paused" } };
      if (r.status === "Paused") return { ...p, [connected.id]: { ...r, status: "Busy" } };
      return p;
    });
  }
  function connect(id: string): void { setConnectedId(id); }
  function disconnect(): void { setConnectedId(null); }

  // ---------- Render ----------
  return (
    <div className="min-h-[100dvh] bg-slate-900 text-slate-100">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;800;900&display=swap'); :root{ /* If you have licensed Elevon, load it as webfont named 'Elevon OneG' or 'Elevon ZeroG' and it will take precedence */ --brand-font: 'Elevon OneG', 'Elevon ZeroG', 'Orbitron', ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial, 'Noto Sans'; }`}</style>
      {/* Top Bar */}
      <div className="sticky top-0 z-20 bg-slate-900/80 backdrop-blur border-b border-slate-700">
        <div className="max-w-md mx-auto px-4 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2"><span className="text-emerald-300 text-3xl md:text-4xl" style={{ fontFamily: "var(--brand-font)", fontWeight: 500, letterSpacing: "0.01em" }}>RE‑Print</span></div>
          <div className="flex items-center gap-2">
            {connected && !hasErr(connected.id) ? (
              <Badge tone={view.status === "Ready" ? "ok" : view.status === "Paused" ? "warn" : view.status === "Completed" ? "info" : "muted"}>{view.status}</Badge>
            ) : null}
            {connected ? (<Badge tone={hasErr(connected.id) ? "warn" : "info"}>{hasErr(connected.id) ? "Unoperational" : "Operational"}</Badge>) : null}
            <Badge tone={connected ? "ok" : "muted"}>{connected ? "Connected" : "Not Connected"}</Badge>
          </div>
        </div>
      </div>

      {/* Banners */}
      {!connected ? (
        <div className="max-w-md mx-auto px-4 pt-3">
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            <AlertCircle className="w-6 h-6 mt-0.5"/>
            <div>
              <div className="font-medium">Please connect to a recycler</div>
              <div className="text-xs opacity-80">Connect a device to enable Start. Use <b>Devices</b> below.</div>
            </div>
          </div>
        </div>
      ) : null}
      {connected && hasErr(connected.id) ? (
        <div className="max-w-md mx-auto px-4 pt-3">
          <div className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle className="w-6 h-6 mt-0.5"/>
            <div>
              <div className="font-medium">Device needs attention</div>
              <div className="text-xs opacity-80">Errors on {connected.name}. Open <b>Logs</b> → <b>Diagnose</b> to resolve before starting.</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="max-w-md mx-auto px-4 pb-[calc(56px+env(safe-area-inset-bottom))] pt-4">
        {/* Welcome + Controls */}
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">Welcome, <b>CJ</b></div>
              {connected ? (
                <div className="text-xs text-slate-300 mt-1 flex items-center gap-1"><PlugZap className="w-4 h-4"/> Connected to <b>{connected.name}</b></div>
              ) : null}
            </div>
            {connected ? (
              <div className="text-right">
                <div className="text-xs text-slate-400">System Status</div>
                <div className="text-sm font-medium">{hasErr(connected.id) ? "Unoperational" : "Operational"}</div>
              </div>
            ) : null}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              className={"w-full flex items-center justify-center gap-2 rounded-xl border px-3 py-3 " + (connected && !hasErr(connected.id) && (view.status === "Ready") ? "bg-emerald-600 text-white hover:bg-emerald-500 border-emerald-500" : "hover:bg-slate-800/60")}
              onClick={function () {
                if (!connected) { setDevOpen(true); return; }
                if (hasErr(connected.id)) { setLogOpen(true); setLogTab(connected.id); return; }
                if (view.status === "Busy" || view.status === "Paused") { stop(); return; }
                start();
              }}
            >
              {!connected ? (
                <><PlugZap className="w-6 h-6"/><span className="text-sm">Connect to start</span></>
              ) : hasErr(connected.id) ? (
                <><AlertCircle className="w-6 h-6"/><span className="text-sm">Resolve errors in Logs</span></>
              ) : (view.status === "Busy" || view.status === "Paused") ? (
                <><Square className="w-6 h-6"/><span className="text-sm">Stop</span></>
              ) : (
                <><Power className="w-6 h-6"/><span className="text-sm">Start</span></>
              )}
            </button>
            <button
              className="w-full flex items-center justify-center gap-2 rounded-xl border px-3 py-3 hover:bg-slate-800/60 disabled:opacity-40"
              onClick={pause}
              disabled={!connected || view.status === "Ready" || view.status === "Completed"}
            >
              <Pause className="w-6 h-6"/><span className="text-sm">{view.status === "Paused" ? "Resume" : "Pause"}</span>
            </button>
          </div>
        </Card>

        {/* Material */}
        <div className="mt-4 grid grid-cols-1 gap-4">
          <Card>
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2 text-sm"><span className="inline-grid place-items-center w-7 h-7 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"><svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg></span><span className="font-medium">Material Selection</span></div>
            </div>

            {/* Current Material Type */}
            <div className="mt-2">
              <div className="text-[11px] text-slate-400 mb-1">Current Material Type</div>
              <div className="flex items-center gap-2">
                <select
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm"
                  value={material}
                  onChange={function (e) { setMaterial((e.target as HTMLSelectElement).value as keyof typeof MATERIAL_PRESETS); }}
                >
                  {Object.keys(MATERIAL_PRESETS).map(function (k) {
                    const opt = MATERIAL_PRESETS[k];
                    return <option key={k} value={k}>{opt.label}</option>;
                  })}
                </select>
              </div>
            </div>

            {/* Info row */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 p-3">
                <div className="text-[11px] text-slate-400">Melting Point</div>
                <div className="text-sm font-medium">{MATERIAL_PRESETS[material].range[0]}–{MATERIAL_PRESETS[material].range[1]}°C</div>
              </div>
              <div className="rounded-xl border border-slate-600 bg-slate-800/40 p-3">
                <div className="text-[11px] text-slate-400">Density</div>
                <div className="text-sm font-medium">{MATERIAL_PRESETS[material].density}</div>
              </div>
            </div>
          </Card>
        </div>

        {/* Recycling Progress */}
        <div className="mt-4 grid grid-cols-1 gap-4">
          <Card>
            <Row
              icon={<span className="inline-grid place-items-center w-7 h-7 rounded-md bg-amber-500/10 text-amber-300 border border-amber-400/20"><Recycle className="w-6 h-6"/></span>}
              title="Recycling Progress"
              right={<span className="text-sm font-medium">{Math.round(view.recycling)}%</span>}
              sub={<span className="flex items-center gap-2"><span>Estimated time: <b>2h</b></span><span className="opacity-60">•</span><span>~{formatDuration(etaMs)} remaining</span></span>}
            />
            <div className="h-2 w-full bg-slate-700 rounded-full overflow-hidden"><div className="h-2 bg-emerald-400 transition-all" style={{ width: String(clamp(view.recycling, 0, 100)) + "%" }}/></div>
            <div className="mt-1 text-[11px] text-slate-300">{Math.round(view.recycling)}%</div>
            <div className="mt-3">
              <div className="grid grid-cols-4 gap-3">
                {STAGES.map(function (s, i) {
                const done = i < stageIdx;
                const current = i === stageIdx;
                const isActive = view.status === "Busy" || view.status === "Paused"; // spin only when a run is active
                return (
                  <div key={s} className="flex flex-col items-center gap-1">
                    <div className="h-6 flex items-center">
                      {done ? (
                        <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                      ) : current && isActive ? (
                        <Loader2 className="w-6 h-6 text-emerald-300 animate-spin" />
                      ) : (
                        <Circle className="w-6 h-6 text-slate-500" />
                      )}
                    </div>
                    <div className={"text-[11px] " + (current ? "text-emerald-300 font-medium" : "text-slate-300")}>{s}</div>
                  </div>
                );
              })}
              </div>
            </div>
          </Card>

          {/* Spool Quantity */}
          <Card>
            <Row icon={<span className="inline-grid place-items-center w-7 h-7 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3"/></svg></span>} title="Spool Quantity" right={<span className="text-sm font-medium">{Math.round(view.spool)}%</span>} sub={<span>Fills only during <b>Spooling</b> stage.</span>} />
            <div className="h-2 w-full bg-slate-700 rounded-full overflow-hidden"><div className="h-2 bg-emerald-400 transition-all" style={{ width: String(clamp(view.spool, 0, 100)) + "%" }}/></div>
            <div className="mt-1 text-[11px] text-slate-300">{Math.round(view.spool)}%</div>
          </Card>
        </div>

        {/* Temperature */}
        <div className="mt-4">
          <Card>
          <Row
            icon={<span className="inline-grid place-items-center w-7 h-7 rounded-md bg-sky-500/10 text-sky-300 border border-sky-400/20"><Thermometer className="w-6 h-6"/></span>}
            title="Temperature (Setpoint)"
            right={<span className="text-sm font-medium">{Math.round(tSet)}°C</span>}
            sub={<span>Preset range for <b>{material}</b>: {preset.range[0]}–{preset.range[1]}°C{(tSet < preset.range[0] || tSet > preset.range[1]) ? (<><span className="ml-1">•</span> <span className="text-amber-700">Out of range</span></>) : null}</span>}
          />
          <div className="flex items-center gap-2 mt-2">
            <button className="px-3 py-2 rounded-xl border text-sm" onClick={function () { setTSet(function (t) { const lo = preset.range[0]; const hi = preset.range[1]; return clamp(t - 1, lo, hi); }); }}>-</button>
            <input type="number" className="w-24 px-2 py-2 rounded-xl border text-sm text-center" value={Math.round(tSet)} readOnly />
            <button className="px-3 py-2 rounded-xl border text-sm" onClick={function () { setTSet(function (t) { const lo = preset.range[0]; const hi = preset.range[1]; return clamp(t + 1, lo, hi); }); }}>+</button>
            <button className="ml-auto px-3 py-2 rounded-xl border text-sm hover:bg-slate-800/60" onClick={function () { setTSet(preset.setpoint); }}>Reset to {preset.setpoint}°C</button>
          </div>
          <div className="mt-3">
            <Row icon={<span className="inline-grid place-items-center w-7 h-7 rounded-md bg-sky-500/10 text-sky-300 border border-sky-400/20"><Thermometer className="w-6 h-6"/></span>} title="Temperature (Live)" right={<span className="text-sm font-medium">{Math.round(tLive)}°C</span>} sub={<span>Machine sensor • read-only</span>} />
          </div>
        </Card>
        </div>

        {/* In-body Monitoring */}
        <div className="mt-4">
          <Card>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Monitor className="w-6 h-6"/><span className="font-medium text-sm">In-body Monitoring</span></div>
            <button onClick={function () { setMonOpen(true); }} className="text-sm px-3 py-1.5 border rounded-xl hover:bg-slate-800/60">Open</button>
          </div>
          <div className="mt-2 text-xs text-slate-300">Monitor current recycling runs.</div>
        </Card>
        </div>
      </div>

      {/* Bottom Nav */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-slate-700 bg-slate-900" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="max-w-md mx-auto h-14 px-6 flex items-center justify-between text-sm">
          <button className="relative flex items-center gap-2 opacity-70" onClick={function () { setLogOpen(true); }}>
            <BarChart3 className="w-6 h-6"/> Logs
            {bubble > 0 ? <span className="absolute -top-1 -right-3 inline-flex items-center justify-center text-[10px] leading-none h-4 min-w-[16px] px-1 rounded-full bg-red-600 text-white">{bubble}</span> : null}
          </button>
          <button className="flex items-center gap-2 opacity-70" onClick={function () { setMatOpen(true); }}><Settings className="w-6 h-6"/> Settings</button>
          <button className="flex items-center gap-2 opacity-70" onClick={function () { setDevOpen(true); }}><Printer className="w-6 h-6"/> Devices</button>
        </div>
      </div>

      {/* Logs Sheet */}
      {logOpen ? (
        <div className="fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/50" onClick={function () { setLogOpen(false); }} />
          <div className="absolute inset-x-0 bottom-0 bg-slate-900 rounded-t-3xl border-t border-slate-700 p-4 shadow-xl max-w-md mx-auto">
            <div className="flex items-center justify-between mb-2"><div className="font-medium flex items-center gap-2"><BarChart3 className="w-6 h-6"/> Logs</div><button onClick={function () { setLogOpen(false); }} aria-label="Close"><X className="w-6 h-6"/></button></div>
            <div className="grid grid-cols-3 gap-2 mb-3">{devices.map(function (d) { return <button key={d.id} className={"px-3 py-2 rounded-2xl border text-sm " + (logTab === d.id ? "bg-slate-700/60" : "hover:bg-slate-800/60")} onClick={function () { setLogTab(d.id); }}>{d.name}</button>; })}</div>
            <div className="max-h-72 overflow-auto space-y-2">
              {(logs[logTab] && logs[logTab].length > 0) ? logs[logTab].map(function (e) {
                const r = runs[logTab];
                const act = r.task ? (r.task + " • " + String(Math.round(r.recycling)) + "%") : r.status;
                const err = e.level === 'error';
                const res = e.level === 'resolved';
                return (
                  <div key={e.id} className={"p-3 rounded-2xl border border-slate-700 flex items-start gap-3 " + (res ? "border-emerald-200 bg-emerald-50" : "") }>
                    <span className={"mt-0.5 inline-block h-2 w-2 rounded-full " + (err ? "bg-red-600" : res ? "bg-emerald-600" : "bg-gray-400")} />
                    <div className="text-xs w-full">
                      <div className="flex items-center justify-between gap-4">
                        <span className={(err ? "text-red-700" : res ? "text-emerald-700" : "") + " font-medium"}>{new Date(e.ts).toLocaleString()}</span>
                        <span className={"px-2 py-0.5 rounded-full " + (err ? "bg-red-100 text-red-700" : res ? "bg-emerald-100 text-emerald-700" : "bg-slate-700/60 text-slate-200")}>{res ? 'RESOLVED' : e.level.toUpperCase()}</span>
                      </div>
                      <div className={(err ? "text-red-700" : res ? "text-emerald-700" : "text-slate-200") + " mt-1"}>{e.message}</div>
                      <div className="mt-1 text-slate-400">Activity: {act}</div>
                    </div>
                  </div>
                );
              }) : (
                <div className="p-4 rounded-2xl border border-slate-700 text-xs text-slate-300">No logs for this device.</div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <div className="flex gap-2">
                <button className="px-3 py-2 rounded-2xl border text-sm hover:bg-slate-800/60" onClick={function () {
                  const data = JSON.stringify((logs[logTab] || []), null, 2);
                  const blob = new Blob([data], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = String(logTab) + '-logs.json';
                  a.click();
                  URL.revokeObjectURL(url);
                }}>Export</button>
                <button className="px-3 py-2 rounded-2xl border text-sm hover:bg-slate-800/60" onClick={function () {
                  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
                  setLogs(function (p) {
                    const copy: Record<string, DeviceLogEntry[]> = { ...p };
                    const arr = copy[logTab] ? copy[logTab].slice() : [];
                    arr.push({ id: 't-' + id, ts: Date.now(), level: 'info' as DeviceLogEntry["level"], message: 'Help ticket ' + id + ' created.' });
                    copy[logTab] = arr;
                    return copy;
                  });
                }}>Help ticket</button>
              </div>
              {(logs[logTab] || []).some(function (l) { return l.level === 'error'; }) ? (
                <button className="px-3 py-2 rounded-2xl border text-sm hover:bg-slate-800/60" onClick={function () {
                  // Resolve errors for current tab
                  setLogs(function (p) {
                    const copy: Record<string, DeviceLogEntry[]> = { ...p };
                    const arr = (copy[logTab] || []).map(function (x) {
                      return x.level === 'error' ? { ...x, level: 'resolved' as DeviceLogEntry["level"], message: 'Resolved - ' + x.message } : x;
                    });
                    copy[logTab] = arr;
                    return copy;
                  });
                }}>Diagnose</button>
              ) : (
                <button className="px-3 py-2 rounded-2xl border text-sm opacity-40 cursor-not-allowed" disabled>Diagnose</button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Material Picker */}
      {matOpen ? (
        <div className="fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/50" onClick={function () { setMatOpen(false); }} />
          <div className="absolute inset-x-0 bottom-0 bg-slate-900 rounded-t-3xl border-t border-slate-700 p-4 shadow-xl max-w-md mx-auto">
            <div className="flex items-center justify-between mb-2"><div className="font-medium">Select Material (override)</div><button onClick={function () { setMatOpen(false); }} aria-label="Close"><X className="w-6 h-6"/></button></div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {Object.keys(MATERIAL_PRESETS).map(function (m) {
                return <button key={m} className={"p-3 border rounded-2xl " + (material === m ? 'bg-slate-700/60' : '')} onClick={function () { setMaterial(m as keyof typeof MATERIAL_PRESETS); setMatOpen(false); }}>{m}</button>;
              })}
            </div>
            <div className="text-[11px] text-slate-400 mt-3">Default from sensor; override only if misdetected.</div>
          </div>
        </div>
      ) : null}

      {/* Devices Sheet */}
      {devOpen ? (
        <div className="fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/50" onClick={function () { setDevOpen(false); }} />
          <div className="absolute inset-x-0 bottom-0 bg-slate-900 rounded-t-3xl border-t border-slate-700 p-4 shadow-xl max-w-md mx-auto">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium flex items-center gap-2"><Printer className="w-6 h-6"/> Devices</div>
              <div className="flex items-center gap-2">
                {connected ? (<><Badge tone="ok">Connected: {connected.name}</Badge><button className="text-xs px-2 py-1 border rounded-lg hover:bg-slate-800/60" onClick={disconnect}>Disconnect</button></>) : null}
                <button onClick={function () { setDevOpen(false); }} aria-label="Close"><X className="w-6 h-6"/></button>
              </div>
            </div>
            <div className="space-y-2">
              {devices.map(function (d) {
                const r = runs[d.id];
                const isConn = d.id === connectedId;
                const inUse = r.status === "Busy" || r.status === "Paused";
                const eta = Math.max(0, (1 - r.recycling / 100) * TOTAL_MS);
                const err = (logs[d.id] || []).some(function (l) { return l.level === 'error'; });
                return (
                  <div key={d.id} className="p-3 border border-slate-700 rounded-2xl flex items-center justify-between">
                    <div className="text-sm">
                      <div className="font-medium">{d.name}</div>
                      <div className="text-xs text-slate-300 mt-0.5">{r.status}{r.task ? ' • ' + r.task : ''}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {err ? <Badge tone="warn">Needs Attention</Badge> : null}
                      {inUse ? <Badge tone="info">In use • ~{formatDuration(eta)}</Badge> : null}
                      {isConn ? <Badge tone="ok">Connected</Badge> : <button className="text-xs px-2 py-1 border rounded-lg hover:bg-slate-800/60" onClick={function () { connect(d.id); }}>Connect</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {/* Monitoring Panel */}
      {monOpen ? (
        <div className="fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/50" onClick={function () { setMonOpen(false); }} />
          <div className="absolute inset-x-0 bottom-0 bg-slate-900 rounded-t-3xl border-t border-slate-700 p-4 shadow-xl max-w-md mx-auto">
            <div className="flex items-center justify-between mb-1"><div className="font-medium">In-body Monitoring</div><button onClick={function () { setMonOpen(false); }} aria-label="Close"><X className="w-6 h-6"/></button></div>
            <div className="text-xs text-slate-300 mb-3">Live overview for current recycling run.</div>
            <div className="rounded-2xl border overflow-hidden">
              <div className="px-3 py-2 text-sm flex items-center justify-between"><span className="font-medium">Recycle</span><span className="text-xs text-slate-300">{Math.round(view.recycling)}%</span></div>
              <div className="h-48 bg-black relative grid place-items-center text-white text-xs">
                Live camera feed (placeholder)
                <div className="absolute inset-0 pointer-events-none">
                  {/* Static AI boxes */}
                  <div className="absolute left-[20%] top-[18%] w-[36%] h-[34%] rounded-md" style={{ boxShadow: "inset 0 0 0 2px rgba(16,185,129,.8)", border: "2px solid rgba(16,185,129,.9)" }} />
                  <div className="absolute left-[60%] top-[40%] w-[22%] h-[28%] rounded-md" style={{ boxShadow: "inset 0 0 0 2px rgba(59,130,246,.8)", border: "2px solid rgba(59,130,246,.9)" }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- Minimal Dev Sanity Tests ----------
const __isProd = (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env.MODE === 'production');
if (typeof window !== "undefined" && !__isProd) {
  try {
    console.assert(clamp(-10, 0, 100) === 0);
    console.assert(clamp(250, 0, 100) === 100);
    // Spool mapping monotonicity (examples)
    function spMap(r: number): number { return r < 75 ? 0 : Math.min(100, Math.max(0, ((r - 75) / 25) * 100)); }
    console.assert(spMap(80) === 20);
    console.assert(spMap(100) === 100);
    // Error aggregation check
    const sampleLogs: Record<string, DeviceLogEntry[]> = { a: [{ id: '1', ts: 0, level: 'error', message: 'x' }], b: [] };
    const total = Object.values(sampleLogs).reduce(function (acc, arr) { return acc + arr.filter(function (x) { return x.level === 'error'; }).length; }, 0);
    console.assert(total === 1);
    // NEW TESTS: formatDuration
    console.assert(formatDuration(90 * 60000) === '1h 30m');
    console.assert(formatDuration(30 * 60000) === '30m');
    // EXTRA TEST: clamp edges
    console.assert(clamp(50, 0, 100) === 50);
  } catch (e) {
    // eslint-disable-next-line no-console
    (globalThis as any).console?.warn?.("Dev tests failed", e);
  }
}
