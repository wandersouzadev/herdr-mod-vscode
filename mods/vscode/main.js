// VS Code: every space's folder, opened in Visual Studio Code. A space on
// another machine opens remotely: WSL distros through Remote-WSL (they live
// on this PC), every other machine through Remote-SSH with the ssh target
// `hc machine ls` reports.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, notify, props, closeOverlay, pickFolder, spaces, panes, theme, window } from "herdr";

const ICON = "mods/vscode/code.svg";
const SPINNER = "mods/workspace-chrome/spinner.svg";

const stop = (_e, cx) => cx.stop_propagation();

// wsl.exe answers in UTF-16LE, so stdout carries NUL bytes.
const cleanWsl = (text) => String(text ?? "").replace(/\u0000/g, "").replace(/\r/g, "");
const normalize = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function parseDistros(text) {
  return cleanWsl(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// A Herdr machine whose host is this PC and whose target (or name) names an
// installed WSL distro is that distro: Remote-WSL reaches it by name. An
// exact match wins; "Ubuntu26" also finds "Ubuntu-26.04".
function matchDistro(machine, distros, localHost) {
  // Only distros on this PC can be reached with Remote-WSL; another machine
  // that happens to share a name stays on SSH.
  if (!localHost || normalize(machine.host) !== localHost) return null;
  const keys = [machine.target, machine.name].map(normalize).filter(Boolean);
  for (const distro of distros) {
    if (keys.includes(normalize(distro))) return distro;
  }
  for (const distro of distros) {
    const n = normalize(distro);
    if (n.length < 5) continue;
    for (const key of keys) {
      if (key.length >= 5 && (key.includes(n) || n.includes(key))) return distro;
    }
  }
  return null;
}

// Where a space is now: its first terminal's live folder, else where it
// was made. `space.folder` never moves, so a terminal that `cd`s elsewhere
// would open the wrong project.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

export default class VSCode extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    // A dialog mounts after init; take the keyboard once it is there.
    cx.timer.after(60, () => this.handle.focus());
    this.targets = {}; // machine name -> ssh target
    this.wsl = {}; // machine name -> WSL distro name
    this.machines = []; // machine names from hc machine ls
    this.loading = true;
    this.busy = null; // space id being opened
    this.error = null;
    cx.spawn(async (cx) => {
      await this.loadMachines();
      this.loading = false;
      cx.notify();
    });
  }

  // `hc machine ls` knows the ssh target each machine was added with; that
  // is what Remote-SSH expects after `ssh-remote+`. WSL distros are local
  // and go through Remote-WSL instead, with the distro name after `wsl+`.
  async loadMachines() {
    try {
      const [r, w, h] = await Promise.all([
        hc(["machine", "ls", "--json"]),
        this.platform() === "windows"
          ? exec("wsl.exe", ["-l", "-q"]).catch(() => null)
          : Promise.resolve(null),
        exec("hostname").catch(() => null),
      ]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc exited with ${r.code}`).trim());
      const list = JSON.parse(r.stdout || "{}").machines ?? [];
      const distros = w && w.code === 0 ? parseDistros(w.stdout) : [];
      const localHost = normalize(h?.stdout?.trim());
      const targets = {};
      const wsl = {};
      const names = [];
      for (const m of list) {
        if (!m || m.temporary || !m.name) continue;
        targets[m.name] = m.target || m.name;
        const distro = matchDistro(m, distros, localHost);
        if (distro) wsl[m.name] = distro;
        names.push(m.name);
      }
      this.targets = targets;
      this.wsl = wsl;
      this.machines = names;
      this.error = null;
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  platform() {
    return window()?.platform ?? "windows";
  }

  target(space) {
    return this.targets[space.machine] || space.machine;
  }

  // How to reach a space's machine in VS Code: a local WSL distro by name,
  // anything else over SSH.
  remoteFor(space) {
    const distro = space.machine ? this.wsl[space.machine] : null;
    if (distro) {
      return { kind: "wsl", prefix: "wsl", target: distro, label: "Remote-WSL", detail: `wsl target ${distro}` };
    }
    const target = this.target(space);
    return { kind: "ssh", prefix: "ssh-remote", target, label: "Remote-SSH", detail: `ssh target ${target}` };
  }

  // `code` is a CLI script on macOS/Linux and code.cmd on Windows, which
  // CreateProcess cannot start directly; cmd.exe resolves it.
  async code(args) {
    if (this.platform() === "windows") {
      try {
        return await exec("code", args);
      } catch {
        return await exec("cmd.exe", ["/d", "/c", "code", ...args]);
      }
    }
    return exec("code", args);
  }

  launch(space, fresh, cx) {
    if (this.busy) return;
    this.busy = space.id;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let opened = false;
      try {
        const args = [fresh ? "--new-window" : "--reuse-window"];
        if (space.machine) {
          const remote = this.remoteFor(space);
          args.push("--remote", `${remote.prefix}+${remote.target}`);
        }
        const folder = place(space);
        if (folder) args.push(folder);
        const r = await this.code(args);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `code exited with ${r.code}`).trim());
        opened = true;
      } catch (e) {
        this.error = String(e?.message ?? e);
        notify({ title: "VS Code", body: `Couldn't open ${space.name}: ${this.error}`, level: "error" });
      }
      this.busy = null;
      cx.notify();
      if (opened) {
        const id = props()?.overlay;
        if (id) closeOverlay(id);
      }
    });
  }

  pick(cx) {
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Open in VS Code" });
        if (!folder) return;
        this.launch({ id: "picked", name: folder, folder, machine: null, active: false }, false, cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  badge(t, text, color) {
    return div()
      .h(16)
      .px(6)
      .flex()
      .items_center()
      .rounded(4)
      .bg(color + "22")
      .text_size(10)
      .font_medium()
      .text_color(color)
      .child(text);
  }

  button(t, id, label, primary, onClick) {
    return h_flex()
      .id(id)
      .h(26)
      .px(10)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(11.5)
      .font_medium()
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.muted)
      .border_1()
      .border_color(primary ? t.solid : t.input)
      .cursor_pointer()
      .when(primary, (el) => el.opacity(0.94).hover((s) => s.opacity(1)))
      .when(!primary, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(label);
  }

  busyRow(t) {
    return h_flex()
      .h(26)
      .px(10)
      .gap(7)
      .flex_none()
      .items_center()
      .child(svg(SPINNER).size(12).text_color(t.working).spin(900))
      .child(div().text_size(11.5).text_color(t.muted).child("Opening"));
  }

  primaryCard(t, s, cx) {
    const remote = Boolean(s.machine);
    const route = remote ? this.remoteFor(s) : null;
    const routeColor = route?.kind === "wsl" ? t.done : t.accent;
    const folder = place(s);
    return v_flex()
      .id("vscode-current")
      .mt(12)
      .p(12)
      .gap(10)
      .rounded(10)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(svg(ICON).size(22).flex_none().text_color(remote ? routeColor : t.accent))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(3)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .min_w(0)
                  .child(div().min_w(0).truncate().text_size(14).font_semibold().child(s.name))
                  .when(remote, (el) => el.child(this.badge(t, s.machine, t.dim)))
                  .when(remote, (el) => el.child(this.badge(t, route.label, routeColor)))
                  .when(!remote, (el) => el.child(this.badge(t, "this computer", t.dim))),
              )
              .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(folder || "home")),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .justify_end()
          .items_center()
          .child(
            div()
              .flex_1()
              .text_size(10.5)
              .text_color(t.dim)
              .child(remote ? route.detail : "local window"),
          )
          .when(this.busy === s.id, (el) => el.child(this.busyRow(t)))
          .when(this.busy !== s.id, (el) => el
            .child(this.button(t, "vscode-current-reuse", "Reuse window", false, (_e, cx) => this.launch(s, false, cx)))
            .child(this.button(t, "vscode-current-new", "New window", true, (_e, cx) => this.launch(s, true, cx)))),
      );
  }

  row(t, s, cx) {
    const remote = Boolean(s.machine);
    const route = remote ? this.remoteFor(s) : null;
    const routeColor = route?.kind === "wsl" ? t.done : t.accent;
    const folder = place(s);
    const busy = this.busy === s.id;
    return h_flex()
      .id(`vscode-${s.id}`)
      .min_h(48)
      .px(10)
      .py(6)
      .gap(10)
      .rounded(8)
      .when(!busy, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)))
      .on_click((e, cx) => this.launch(s, !e.modifiers.shift, cx))
      .child(svg(ICON).size(18).flex_none().text_color(remote ? routeColor : t.muted))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(s.name))
              .when(s.active, (el) => el.child(this.badge(t, "current", t.accent)))
              .when(remote, (el) => el.child(this.badge(t, s.machine, t.dim))),
          )
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(folder || "home"))
              .when(remote, (el) => el.child(div().flex_none().text_size(10.5).text_color(routeColor).child(`${route.label} · ${route.target}`))),
          ),
      )
      .when(busy, (el) => el.child(this.busyRow(t)))
      .when(!busy, (el) => el.child(this.button(t, `vscode-reuse-${s.id}`, "Reuse window", false, (_e, cx) => this.launch(s, false, cx))));
  }

  render(cx) {
    const t = theme();
    const all = spaces();
    const active = all.find((s) => s.active) ?? null;
    const others = all.filter((s) => !active || s.id !== active.id);
    return v_flex()
      .id("vscode")
      .w_full()
      .min_h(0)
      .p(16)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          const id = props()?.overlay;
          if (id) closeOverlay(id);
          return;
        }
        if (e.key === "enter" && active && !e.modifiers.control && !e.modifiers.alt && !e.modifiers.platform) {
          this.launch(active, !e.modifiers.shift, cx);
        }
      })
      .child(
        h_flex()
          .items_center()
          .gap(9)
          .child(svg(ICON).size(18).flex_none().text_color(t.accent))
          .child(div().flex_none().text_size(15).font_semibold().child("VS Code"))
          .child(
            div()
              .flex_1()
              .text_size(11)
              .text_color(t.dim)
              .child(this.loading ? "Reading machines…" : `${this.machines.length} machine${this.machines.length === 1 ? "" : "s"} through herdr`),
          )
          .child(this.button(t, "vscode-refresh", "Refresh", false, (_e, cx) => {
            this.loading = true;
            this.error = null;
            cx.notify();
            cx.spawn(async (cx) => {
              await this.loadMachines();
              this.loading = false;
              cx.notify();
            });
          })),
      )
      .child(
        div()
          .pt(5)
          .text_size(12.5)
          .line_height("18px")
          .text_color(t.muted)
          .child("Open a space's folder here, or remotely: WSL distros use Remote-WSL, other machines Remote-SSH."),
      )
      .when(Boolean(this.error), (el) => el.child(
        div()
          .mt(10)
          .p(9)
          .rounded(7)
          .bg(t.blocked + "1f")
          .text_size(11.5)
          .line_height("16px")
          .text_color(t.blocked)
          .child(this.error),
      ))
      .when(Boolean(active), (el) => el.child(this.primaryCard(t, active, cx)))
      .when(others.length > 0, (el) => el
        .child(div().pt(14).pb(4).text_size(11).font_medium().text_color(t.dim).child("OTHER SPACES"))
        .child(
          v_flex()
            .id("vscode-list")
            .gap(2)
            .max_h(330)
            .overflow_y_scrollbar()
            .children(others.map((s) => this.row(t, s, cx))),
        ))
      .when(!active && others.length === 0, (el) => el.child(
        div().pt(14).text_size(12).text_color(t.dim).child("No spaces yet. Start one in Herdr, then come back."),
      ))
      .child(
        h_flex()
          .pt(12)
          .gap(8)
          .items_center()
          .child(this.button(t, "vscode-folder", "Open folder…", false, (_e, cx) => this.pick(cx)))
          .child(div().flex_1())
          .child(div().text_size(10.5).text_color(t.dim).child("Click a space: new window · Shift+click: reuse one · Enter: current space")),
      );
  }
}
