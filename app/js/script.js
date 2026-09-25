/* =====================================================================
   Non-Funded Partnership Application — dashboard widget
   Fetches Zoho Creator reports via the Widget SDK v2 and renders
   KPIs + SVG charts. No external libraries.

   A. Cumulative dashboard (till date)  B. Daily dashboard (today)
   KPIs: emails sent (form-sharing module), form responses received,
         approved / rejected / sent-back cases.
   Filters: assignee + date range.

   Data sources
   - Applications report : current Status + Assignee of every application
   - Audit log report    : one row per action (Submitted / Approved /
                           Rejected / Sent Back / Resubmitted) with its
                           timestamp — gives every event a date
   - Emails report       : form-sharing emails with their sent date
   ===================================================================== */
(function () {
    "use strict";

    var CONFIG = {
        appLinkName: "non-funded-partnership-application",
        reports: {
            applications: { name: "NSDC_Partnership_Application_Report", fields: "Status,Assignee" },
            audit: { name: "Audit_Log_Report", fields: "NSDC_Partnership_Application_Form,Action_field,Action_Time" },
            emails: { name: "All_Emails", fields: "Email_Sent_Date" }
        },
        fields: {
            status: "Status",
            assignee: "Assignee",
            auditApp: "NSDC_Partnership_Application_Form",
            auditAction: "Action_field",
            auditTime: "Action_Time",
            emailSent: "Email_Sent_Date"
        },
        pageSize: 200,
        maxPages: 50,          // up to 10,000 records per report
        initTimeoutMs: 9000,
        fetchTimeoutMs: 30000  // per-report cap so one hung fetch can't freeze the UI
    };
    var F = CONFIG.fields;
    var UNASSIGNED = "Unassigned";
    var DAY = 86400000;

    /* Donut segment order — CVD-validated adjacency (do not reorder) */
    var STATUSES = [
        { key: "approved", label: "Approved" },
        { key: "pending", label: "Under review" },
        { key: "rejected", label: "Rejected" },
        { key: "resubmitted", label: "Resubmitted" },
        { key: "sentback", label: "Sent back" }
    ];

    var TILES = [
        { key: "emails", label: "Emails sent", note: "Form-sharing module", chip: "chip-emails", icon: "mail" },
        { key: "responses", label: "Form responses received", chip: "chip-total", icon: "doc" },
        { key: "approved", label: "Approved cases", chip: "chip-approved", icon: "check" },
        { key: "rejected", label: "Rejected cases", chip: "chip-rejected", icon: "x" },
        { key: "sentback", label: "Sent back cases", chip: "chip-sentback", icon: "undo" }
    ];

    var ICONS = {
        doc: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6"],
        check: ["M20 6L9 17l-5-5"],
        x: ["M18 6L6 18", "M6 6l12 12"],
        undo: ["M9 14L4 9l5-5", "M20 20v-7a4 4 0 0 0-4-4H4"],
        mail: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M22 6l-10 7L2 6"]
    };

    var state = {
        datasets: {},          // key -> { records, truncated, error }
        view: "cumulative",    // 'cumulative' | 'daily'
        from: null,            // Date (start of day) | null
        to: null,              // Date (start of day) | null — inclusive
        assignee: "all",
        views: { donut: "chart", trend: "chart", assignee: "chart" },
        sample: false,
        inited: false,
        lastUpdated: null,
        trendFocus: -1
    };

    /* Derived from datasets by buildModel() */
    var model = { apps: [], emails: [] };

    var nf = new Intl.NumberFormat("en-IN");
    function fmt(n) { return nf.format(n); }
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    var el = {
        boot: document.getElementById("boot-state"),
        dashboard: document.getElementById("dashboard"),
        kpiTitle: document.getElementById("kpi-title"),
        kpiPeriod: document.getElementById("kpi-period"),
        kpiGrid: document.getElementById("kpi-grid"),
        donutBody: document.getElementById("donut-body"),
        donutSub: document.getElementById("donut-sub"),
        trendBody: document.getElementById("trend-body"),
        trendSub: document.getElementById("trend-sub"),
        assigneeBody: document.getElementById("assignee-body"),
        assigneeSub: document.getElementById("assignee-sub"),
        sampleBadge: document.getElementById("sample-badge"),
        lastUpdated: document.getElementById("last-updated"),
        refreshBtn: document.getElementById("refresh-btn"),
        viewControl: document.getElementById("view-control"),
        dateFrom: document.getElementById("date-from"),
        dateTo: document.getElementById("date-to"),
        dateClear: document.getElementById("date-clear"),
        dateHint: document.getElementById("date-hint"),
        assigneeControl: document.getElementById("assignee-control"),
        tip: document.getElementById("viz-tip")
    };

    /* ================================================================
       Data layer
       ================================================================ */
    function errText(err) {
        if (!err) return "Unknown error";
        if (typeof err === "string") return err;
        var rt = err.responseText;
        if (typeof rt === "string") { try { rt = JSON.parse(rt); } catch (e) { rt = null; } }
        var m = err.description || err.message || (rt && (rt.description || rt.message));
        if (m) return String(m);
        try { return JSON.stringify(err); } catch (e2) { return String(err); }
    }

    function isNoData(err) {
        /* An empty report is data (count 0), not an error.
           Creator answers HTTP 400 with code 9220 ("No records exist in
           this report.") or 9280 (no records match criteria). */
        if (!err) return false;
        var rt = err.responseText;
        if (typeof rt === "string") { try { rt = JSON.parse(rt); } catch (e) { rt = null; } }
        var code = err.code != null ? err.code : (rt && rt.code);
        return code == 9220 || code == 9280 || code == 3100; // loose ==: SDK may send "9220"
    }

    function fetchReport(rep) {
        /* Ask only for the fields the dashboard needs; if the report
           rejects that field list, fall back to its default columns. */
        var variants = [{ field_config: "custom", fields: rep.fields }, {}];
        function attempt(vi) {
            var out = [], pages = 0;
            function step(cursor) {
                var cfg = { app_name: CONFIG.appLinkName, report_name: rep.name, max_records: CONFIG.pageSize };
                Object.assign(cfg, variants[vi]);
                if (cursor) cfg.record_cursor = cursor;
                return ZOHO.CREATOR.DATA.getRecords(cfg).then(function (res) {
                    if (res && res.data && res.data.length) out = out.concat(res.data);
                    pages++;
                    var next = res && res.record_cursor;
                    if (next && pages < CONFIG.maxPages) return step(next);
                    return { records: out, truncated: !!next };
                });
            }
            return step(null).catch(function (err) {
                if (isNoData(err)) return { records: [], truncated: false };
                if (vi + 1 < variants.length) return attempt(vi + 1);
                throw err;
            });
        }
        return attempt(0);
    }

    function withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var t = setTimeout(function () {
                reject({ message: label + " timed out after " + Math.round(ms / 1000) + "s" });
            }, ms);
            promise.then(
                function (v) { clearTimeout(t); resolve(v); },
                function (e) { clearTimeout(t); reject(e); }
            );
        });
    }

    var loadSeq = 0;
    function loadAll() {
        var seq = ++loadSeq;           // results from an older load are ignored
        var keys = Object.keys(CONFIG.reports);
        var remaining = keys.length;
        state.sample = false;
        el.boot.hidden = true;
        setRefreshing(true);
        keys.forEach(function (k) {
            var rep = CONFIG.reports[k];
            withTimeout(fetchReport(rep), CONFIG.fetchTimeoutMs, rep.name).then(
                function (v) {
                    if (seq !== loadSeq) return;
                    state.datasets[k] = { records: v.records, truncated: v.truncated, error: false };
                    done();
                },
                function (e) {
                    if (seq !== loadSeq) return;
                    console.error("[dashboard] failed to fetch report " + rep.name, e);
                    state.datasets[k] = { records: [], truncated: false, error: true };
                    done();
                }
            );
        });
        function done() {
            remaining--;
            state.lastUpdated = new Date();
            buildModel();
            renderAll();
            if (remaining === 0) setRefreshing(false);
        }
    }

    /* ================================================================
       Parsing & model
       ================================================================ */
    function parseDate(v) {
        if (!v || typeof v !== "string") return null;
        var s = v.trim();
        // dd-MMM-yyyy [HH:mm[:ss]]  (Creator's configured date format)
        var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (m) {
            var mon = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase());
            if (mon < 0) return null;
            return new Date(+m[3], mon, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        }
        return null;
    }

    function cellText(v) {
        if (v == null) return "";
        if (typeof v === "string") return v.trim();
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(", ");
        if (typeof v === "object") return v.zc_display_value || v.display_value || "";
        return "";
    }

    function actionKey(s) {
        var v = String(s || "").toLowerCase();
        if (/resubmit/.test(v)) return "resubmitted";
        if (/sent.?back|send.?back/.test(v)) return "sentback";
        if (/approv/.test(v)) return "approved";
        if (/reject/.test(v)) return "rejected";
        if (/submit/.test(v)) return "submitted";
        return null;
    }

    function statusKey(s) {
        var k = actionKey(s);
        return !k || k === "submitted" ? "pending" : k;
    }

    function buildModel() {
        var byId = {}, apps = [];
        var A = state.datasets.applications, L = state.datasets.audit, E = state.datasets.emails;
        if (A && !A.error) {
            A.records.forEach(function (r) {
                var a = {
                    id: String(r.ID),
                    status: statusKey(cellText(r[F.status])),
                    assignee: cellText(r[F.assignee]) || UNASSIGNED,
                    events: [],
                    receivedAt: null
                };
                byId[a.id] = a;
                apps.push(a);
            });
        }
        if (L && !L.error) {
            L.records.forEach(function (r) {
                var ref = r[F.auditApp];
                var a = byId[String(ref && typeof ref === "object" ? ref.ID : ref)];
                var t = parseDate(r[F.auditTime]);
                var k = actionKey(r[F.auditAction]);
                if (a && t && k) a.events.push({ action: k, time: t });
            });
        }
        /* Response received = the application's first "Submitted" audit
           entry (earliest entry of any kind if none was logged). */
        apps.forEach(function (a) {
            var first = null, submitted = null;
            a.events.forEach(function (e) {
                if (!first || e.time < first) first = e.time;
                if (e.action === "submitted" && (!submitted || e.time < submitted)) submitted = e.time;
            });
            a.receivedAt = submitted || first;
        });
        var emails = [];
        if (E && !E.error) E.records.forEach(function (r) { emails.push(parseDate(r[F.emailSent])); });
        model = { apps: apps, emails: emails };
    }

    /* ================================================================
       Period & filtering
       ================================================================ */
    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
    function fmtDate(d) { return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }

    /* { start, end (exclusive), all, label } */
    function currentPeriod() {
        var today = startOfDay(new Date());
        if (state.view === "daily") {
            return { start: today, end: addDays(today, 1), all: false, label: "Today · " + fmtDate(today) };
        }
        if (!state.from && !state.to) return { start: null, end: null, all: true, label: "Till date · as of " + fmtDate(today) };
        var label = state.from && state.to ? fmtDate(state.from) + " – " + fmtDate(state.to)
            : state.from ? "From " + fmtDate(state.from) : "Till " + fmtDate(state.to);
        return { start: state.from, end: state.to ? addDays(state.to, 1) : null, all: false, label: label };
    }

    function inPeriod(d, p) {
        if (p.all) return true;
        if (!d) return false;
        return (!p.start || d >= p.start) && (!p.end || d < p.end);
    }

    function filteredApps() {
        if (state.assignee === "all") return model.apps;
        return model.apps.filter(function (a) { return a.assignee === state.assignee; });
    }

    /* Applications touched in the period (received or acted on) */
    function activeApps(p) {
        var apps = filteredApps();
        if (p.all) return apps;
        return apps.filter(function (a) {
            return inPeriod(a.receivedAt, p) || a.events.some(function (e) { return inPeriod(e.time, p); });
        });
    }

    /* Approved / Rejected / Sent back:
       - Till date, no date range: cases whose CURRENT status is that
         status (matches the Approved/Rejected/Sent Back Cases reports).
       - Today or a date range: cases that received that action in the
         period, per the audit log. */
    function computeKPIs(p) {
        var apps = filteredApps();
        var r = {
            emails: model.emails.filter(function (d) { return inPeriod(d, p); }).length,
            responses: apps.filter(function (a) { return inPeriod(a.receivedAt, p); }).length
        };
        ["approved", "rejected", "sentback"].forEach(function (k) {
            r[k] = apps.filter(function (a) {
                if (p.all) return a.status === k;
                return a.events.some(function (e) { return e.action === k && inPeriod(e.time, p); });
            }).length;
        });
        return r;
    }

    /* Datasets each KPI depends on under the given period */
    function kpiSources(key, p) {
        if (key === "emails") return ["emails"];
        if (key === "responses" && p.all) return ["applications"];
        return p.all ? ["applications"] : ["applications", "audit"];
    }

    function sourceState(keys) {
        var st = { loading: false, error: false, truncated: false };
        keys.forEach(function (k) {
            var ds = state.datasets[k];
            if (!ds) st.loading = true;
            else if (ds.error) st.error = true;
            else if (ds.truncated) st.truncated = true;
        });
        return st;
    }

    /* ================================================================
       Aggregation — time buckets for the trend
       ================================================================ */
    function trendWindow(p) {
        var today = startOfDay(new Date());
        if (state.view === "daily") return { start: addDays(today, -6), end: addDays(today, 1), context: true };
        var end = p.end || addDays(today, 1);
        var start = p.start;
        if (!start) {
            var earliest = null;
            model.emails.forEach(function (d) { if (d && d < end && (!earliest || d < earliest)) earliest = d; });
            filteredApps().forEach(function (a) {
                if (a.receivedAt && a.receivedAt < end && (!earliest || a.receivedAt < earliest)) earliest = a.receivedAt;
            });
            start = earliest ? startOfDay(earliest) : addDays(end, -30);
        }
        if ((end - start) / DAY < 7) start = addDays(end, -7);
        return { start: start, end: end };
    }

    function buildBuckets(win) {
        var buckets = [], s, e;
        var days = Math.round((win.end - win.start) / DAY);
        if (days <= 31) {
            for (s = win.start; s < win.end; s = addDays(s, 1)) {
                buckets.push({ start: s, end: addDays(s, 1), label: s.getDate() + " " + MONTHS[s.getMonth()] });
            }
            buckets.unit = "Daily";
        } else if (days <= 182) {
            for (s = win.start; s < win.end; s = e) {
                e = addDays(s, 7);
                if (e > win.end) e = win.end;
                buckets.push({ start: s, end: e, label: s.getDate() + " " + MONTHS[s.getMonth()] });
            }
            buckets.unit = "Weekly";
        } else {
            for (s = new Date(win.start.getFullYear(), win.start.getMonth(), 1); s < win.end; s = e) {
                e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
                buckets.push({ start: s, end: e, label: MONTHS[s.getMonth()] + " '" + String(s.getFullYear()).slice(2) });
            }
            buckets.unit = "Monthly";
        }
        return buckets;
    }

    function countInBuckets(dates, buckets) {
        var counts = buckets.map(function () { return 0; });
        dates.forEach(function (d) {
            if (!d) return;
            for (var i = 0; i < buckets.length; i++) {
                if (d >= buckets[i].start && d < buckets[i].end) { counts[i]++; break; }
            }
        });
        return counts;
    }

    /* ================================================================
       Small DOM / SVG helpers  (untrusted data -> textContent only)
       ================================================================ */
    var SVG_NS = "http://www.w3.org/2000/svg";
    function svgEl(tag, attrs) {
        var n = document.createElementNS(SVG_NS, tag);
        if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
        return n;
    }
    function div(cls, text) {
        var d = document.createElement("div");
        if (cls) d.className = cls;
        if (text != null) d.textContent = text;
        return d;
    }
    function iconSvg(name) {
        var s = svgEl("svg", {
            viewBox: "0 0 24 24", width: 15, height: 15,
            fill: "none", stroke: "currentColor", "stroke-width": "2",
            "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"
        });
        (ICONS[name] || []).forEach(function (d) { s.appendChild(svgEl("path", { d: d })); });
        return s;
    }
    function pct(n, total) { return total ? Math.round((n / total) * 100) + "%" : "0%"; }

    /* Tooltip ------------------------------------------------------- */
    function showTip(title, rows, x, y) {
        el.tip.textContent = "";
        if (title) el.tip.appendChild(div("tip-title", title));
        rows.forEach(function (r) {
            var row = div("tip-row");
            if (r.swatch) {
                var k = div("tip-key");
                k.classList.add(r.swatch);
                row.appendChild(k);
            }
            var val = document.createElement("span");
            val.className = "tip-val";
            val.textContent = r.value;
            row.appendChild(val);
            if (r.label) {
                var lab = document.createElement("span");
                lab.className = "tip-label";
                lab.textContent = r.label;
                row.appendChild(lab);
            }
            el.tip.appendChild(row);
        });
        el.tip.hidden = false;
        var pad = 12, rect = el.tip.getBoundingClientRect();
        var nx = Math.min(x + pad, window.innerWidth - rect.width - 8);
        var ny = y - rect.height - pad;
        if (ny < 8) ny = y + pad;
        el.tip.style.left = Math.max(8, nx) + "px";
        el.tip.style.top = ny + "px";
    }
    function hideTip() { el.tip.hidden = true; }

    function emptyState(body, text) {
        body.appendChild(div("chart-empty", text));
    }

    /* Common loading / error guard for chart cards */
    function guard(body, keys) {
        var st = sourceState(keys);
        if (st.error) {
            var failed = keys.filter(function (k) { return state.datasets[k] && state.datasets[k].error; })
                .map(function (k) { return CONFIG.reports[k].name; });
            emptyState(body, "Couldn't load " + failed.join(", "));
            return false;
        }
        if (st.loading) { emptyState(body, "Loading…"); return false; }
        return true;
    }

    /* ================================================================
       Render — KPI tiles
       ================================================================ */
    function renderKPIs(p) {
        el.kpiTitle.textContent = state.view === "daily" ? "Daily dashboard" : "Cumulative dashboard";
        el.kpiPeriod.textContent = p.label + (state.assignee !== "all" ? " · " + state.assignee : "");
        el.kpiGrid.textContent = "";
        var values = computeKPIs(p);
        TILES.forEach(function (t) {
            var st = sourceState(kpiSources(t.key, p));
            var tile = div("kpi-tile");
            tile.setAttribute("role", "group");

            var top = div("kpi-top");
            var chip = div("kpi-chip " + t.chip);
            chip.appendChild(iconSvg(t.icon));
            top.appendChild(chip);
            top.appendChild(div("kpi-label", t.label));
            tile.appendChild(top);

            var valueText = st.loading ? "…" : st.error ? "—" : fmt(values[t.key]) + (st.truncated ? "+" : "");
            tile.appendChild(div("kpi-value" + (st.loading ? " is-loading" : ""), valueText));
            tile.setAttribute("aria-label", t.label + ": " + valueText);

            var note = null, noteCls = "kpi-note";
            if (st.error) { note = "Couldn't load report"; noteCls += " is-error"; }
            else if (st.loading) note = "Loading…";
            else if (t.key === "emails" && state.assignee !== "all") note = "All assignees (emails have no assignee)";
            else if (st.truncated) note = "Record limit reached";
            else if (t.note) note = t.note;
            if (note) tile.appendChild(div(noteCls, note));
            el.kpiGrid.appendChild(tile);
        });
    }

    /* ================================================================
       Render — trend (emails sent vs responses received)
       ================================================================ */
    function axisScale(dataMax) {
        var target = Math.max(1, dataMax) / 4;
        var p = Math.pow(10, Math.floor(Math.log10(target)));
        var f = target / p;
        var step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
        while (step * 4 < dataMax) step *= 2;
        return { max: step * 4, step: step };
    }

    var TREND_SERIES = [
        { key: "emails", name: "Emails sent", lineCls: "trend-line s2", dotCls: "trend-dot s2", hoverCls: "hover-dot s2", sw: "sw-series2" },
        { key: "responses", name: "Responses received", lineCls: "trend-line", dotCls: "trend-dot", hoverCls: "hover-dot", sw: "sw-series1" }
    ];

    function renderTrend(p) {
        el.trendBody.textContent = "";
        var win = trendWindow(p);
        var buckets = buildBuckets(win);
        el.trendSub.textContent = buckets.unit + " · " + fmtDate(win.start) + " – " + fmtDate(addDays(win.end, -1)) +
            (win.context ? " (last 7 days)" : "") +
            (state.assignee !== "all" ? " · emails not assignee-specific" : "");
        if (!guard(el.trendBody, ["emails", "applications", "audit"])) return;

        var series = TREND_SERIES.map(function (d) {
            var dates = d.key === "emails" ? model.emails
                : filteredApps().map(function (a) { return a.receivedAt; });
            return { def: d, counts: countInBuckets(dates, buckets) };
        });

        if (state.views.trend === "table") {
            el.trendBody.appendChild(buildAggTable(
                ["Period"].concat(series.map(function (sr) { return sr.def.name; })),
                buckets.map(function (b, i) {
                    return [b.label].concat(series.map(function (sr) { return fmt(sr.counts[i]); }));
                })
            ));
            return;
        }

        var dataMax = 0;
        series.forEach(function (sr) { sr.counts.forEach(function (c) { dataMax = Math.max(dataMax, c); }); });
        if (!dataMax) { emptyState(el.trendBody, "No emails or responses in this period"); return; }

        var legend = div("chart-legend");
        series.forEach(function (sr) {
            var e = div("legend-entry");
            e.appendChild(div("legend-key " + sr.def.sw));
            e.appendChild(div("legend-label", sr.def.name));
            legend.appendChild(e);
        });
        el.trendBody.appendChild(legend);

        var W = Math.max(320, el.trendBody.clientWidth || 520);
        var H = 236;
        var m = { t: 14, r: 40, b: 26, l: 40 };
        var pw = W - m.l - m.r, ph = H - m.t - m.b;
        var scale = axisScale(dataMax);
        var n = buckets.length;

        var s = svgEl("svg", {
            class: "viz-svg", width: W, height: H, tabindex: "0", role: "img",
            "aria-label": "Emails sent vs responses received, " + el.trendSub.textContent
        });

        for (var g = 0; g <= 4; g++) {
            var yv = scale.step * g;
            var y = m.t + ph - (yv / scale.max) * ph;
            if (g > 0) s.appendChild(svgEl("line", { class: "grid-line", x1: m.l, x2: m.l + pw, y1: y, y2: y }));
            var tick = svgEl("text", { class: "axis-tick", x: m.l - 8, y: y + 3.5, "text-anchor": "end" });
            tick.textContent = fmt(yv);
            s.appendChild(tick);
        }
        s.appendChild(svgEl("line", { class: "axis-line", x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph }));

        function px(i) { return m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw); }
        function py(c) { return m.t + ph - (c / scale.max) * ph; }

        /* x labels (skip to avoid collisions, anchored to the last) */
        var skip = Math.ceil(n / Math.max(2, Math.floor(pw / 58)));
        buckets.forEach(function (b, i) {
            if ((n - 1 - i) % skip !== 0) return;
            var t = svgEl("text", { class: "axis-tick", x: px(i), y: m.t + ph + 17, "text-anchor": "middle" });
            t.textContent = b.label;
            s.appendChild(t);
        });

        /* lines + end markers + end labels (nudged apart if they collide) */
        var endYs = series.map(function (sr) { return py(sr.counts[n - 1]) + 4; });
        if (Math.abs(endYs[0] - endYs[1]) < 14) {
            var gap = (14 - Math.abs(endYs[0] - endYs[1])) / 2;
            if (endYs[0] <= endYs[1]) { endYs[0] -= gap; endYs[1] += gap; }
            else { endYs[1] -= gap; endYs[0] += gap; }
        }
        series.forEach(function (sr, si) {
            var d = sr.counts.map(function (c, i) { return (i ? "L" : "M") + px(i).toFixed(1) + " " + py(c).toFixed(1); }).join(" ");
            s.appendChild(svgEl("path", { class: sr.def.lineCls, d: d }));
            s.appendChild(svgEl("circle", { class: sr.def.dotCls, cx: px(n - 1), cy: py(sr.counts[n - 1]), r: 4 }));
            var endLab = svgEl("text", { class: "end-label", x: px(n - 1) + 9, y: endYs[si] });
            endLab.textContent = fmt(sr.counts[n - 1]);
            s.appendChild(endLab);
        });

        /* hover layer: crosshair + one tooltip listing both series */
        var crossh = svgEl("line", { class: "crosshair", y1: m.t, y2: m.t + ph, x1: 0, x2: 0, visibility: "hidden" });
        s.appendChild(crossh);
        series.forEach(function (sr) {
            sr.hoverDot = svgEl("circle", { class: sr.def.hoverCls, r: 4.5, visibility: "hidden" });
            s.appendChild(sr.hoverDot);
        });

        function focusIndex(i, clientX, clientY) {
            i = Math.max(0, Math.min(n - 1, i));
            state.trendFocus = i;
            var x = px(i);
            crossh.setAttribute("x1", x); crossh.setAttribute("x2", x);
            crossh.setAttribute("visibility", "visible");
            series.forEach(function (sr) {
                sr.hoverDot.setAttribute("cx", x);
                sr.hoverDot.setAttribute("cy", py(sr.counts[i]));
                sr.hoverDot.setAttribute("visibility", "visible");
            });
            var rect = s.getBoundingClientRect();
            showTip(buckets[i].label,
                series.map(function (sr) { return { swatch: sr.def.sw, value: fmt(sr.counts[i]), label: sr.def.name }; }),
                clientX != null ? clientX : rect.left + x,
                clientY != null ? clientY : rect.top + m.t);
        }
        function clearFocus() {
            crossh.setAttribute("visibility", "hidden");
            series.forEach(function (sr) { sr.hoverDot.setAttribute("visibility", "hidden"); });
            hideTip();
        }

        var overlay = svgEl("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent" });
        overlay.addEventListener("pointermove", function (ev) {
            var x = ev.clientX - s.getBoundingClientRect().left;
            var best = 0, bd = Infinity;
            for (var i = 0; i < n; i++) { var dd = Math.abs(px(i) - x); if (dd < bd) { bd = dd; best = i; } }
            focusIndex(best, ev.clientX, ev.clientY);
        });
        overlay.addEventListener("pointerleave", clearFocus);
        s.appendChild(overlay);

        s.addEventListener("keydown", function (ev) {
            if (ev.key === "ArrowLeft") { focusIndex((state.trendFocus < 0 ? n - 1 : state.trendFocus) - 1); ev.preventDefault(); }
            else if (ev.key === "ArrowRight") { focusIndex(state.trendFocus < 0 ? n - 1 : state.trendFocus + 1); ev.preventDefault(); }
            else if (ev.key === "Escape") { clearFocus(); }
        });
        s.addEventListener("focus", function () { focusIndex(n - 1); });
        s.addEventListener("blur", clearFocus);

        el.trendBody.appendChild(s);
    }

    /* ================================================================
       Render — donut (current status of cases active in the period)
       ================================================================ */
    function scopeText(p) {
        return p.all ? "All cases · current status" : "Cases received or acted on in this period · current status";
    }

    function renderDonut(p) {
        el.donutBody.textContent = "";
        el.donutSub.textContent = scopeText(p);
        if (!guard(el.donutBody, p.all ? ["applications"] : ["applications", "audit"])) return;

        var apps = activeApps(p);
        var items = STATUSES.map(function (st) {
            return {
                key: st.key, label: st.label,
                count: apps.filter(function (a) { return a.status === st.key; }).length
            };
        });
        var total = apps.length;

        if (state.views.donut === "table") {
            el.donutBody.appendChild(buildAggTable(
                ["Status", "Cases", "Share"],
                items.map(function (it) { return [it.label, fmt(it.count), pct(it.count, total)]; })
            ));
            return;
        }
        if (!total) { emptyState(el.donutBody, "No cases in this period"); return; }

        var size = 188, cx = size / 2, cy = size / 2, R = 86, r = 57;
        var wrap = div("donut-wrap");
        var box = div("donut-svg-box");
        var s = svgEl("svg", {
            class: "viz-svg", width: size, height: size, role: "img",
            "aria-label": "Case status, " + fmt(total) + " cases"
        });
        var center = div("donut-center");
        var centerBig = div("big", fmt(total));
        var centerSmall = div("small", "cases");
        center.appendChild(centerBig);
        center.appendChild(centerSmall);

        var segs = [];
        var angle = -Math.PI / 2;
        items.forEach(function (it) {
            if (!it.count) return;
            var frac = it.count / total;
            var a0 = angle, a1 = angle + frac * Math.PI * 2;
            angle = a1;
            var share = pct(it.count, total);
            var path = svgEl("path", {
                d: donutArc(cx, cy, R, r, a0, frac >= 0.9999 ? a0 + Math.PI * 1.9999 : a1),
                class: "donut-seg seg-" + it.key,
                tabindex: "0",
                role: "img",
                "aria-label": it.label + ": " + fmt(it.count) + " cases (" + share + ")"
            });
            function activate(x, y) {
                segs.forEach(function (q) { q.style.opacity = q === path ? "1" : "0.35"; });
                centerBig.textContent = fmt(it.count);
                centerSmall.textContent = it.label + " · " + share;
                showTip(it.label, [{ swatch: "sw-" + it.key, value: fmt(it.count) + " cases", label: share }], x, y);
            }
            function deactivate() {
                segs.forEach(function (q) { q.style.opacity = ""; });
                centerBig.textContent = fmt(total);
                centerSmall.textContent = "cases";
                hideTip();
            }
            path.addEventListener("pointermove", function (ev) { activate(ev.clientX, ev.clientY); });
            path.addEventListener("pointerleave", deactivate);
            path.addEventListener("focus", function () {
                var b = path.getBoundingClientRect();
                activate(b.left + b.width / 2, b.top);
            });
            path.addEventListener("blur", deactivate);
            segs.push(path);
            s.appendChild(path);
        });

        box.appendChild(s);
        box.appendChild(center);
        wrap.appendChild(box);

        /* legend with visible counts (relief for low-contrast hues) */
        var legend = div("donut-legend");
        items.forEach(function (it) {
            var row = div("legend-row");
            row.appendChild(div("legend-swatch sw-" + it.key));
            row.appendChild(div("legend-name", it.label));
            row.appendChild(div("legend-count", fmt(it.count)));
            row.appendChild(div("legend-pct", pct(it.count, total)));
            legend.appendChild(row);
        });
        wrap.appendChild(legend);
        el.donutBody.appendChild(wrap);
    }

    function donutArc(cx, cy, R, r, a0, a1) {
        var large = (a1 - a0) > Math.PI ? 1 : 0;
        function pt(rad, a) { return (cx + rad * Math.cos(a)).toFixed(2) + " " + (cy + rad * Math.sin(a)).toFixed(2); }
        return "M " + pt(R, a0) +
            " A " + R + " " + R + " 0 " + large + " 1 " + pt(R, a1) +
            " L " + pt(r, a1) +
            " A " + r + " " + r + " 0 " + large + " 0 " + pt(r, a0) + " Z";
    }

    /* ================================================================
       Render — cases by assignee (horizontal bars stacked by status)
       ================================================================ */
    function renderAssignee(p) {
        el.assigneeBody.textContent = "";
        el.assigneeSub.textContent = scopeText(p);
        if (!guard(el.assigneeBody, p.all ? ["applications"] : ["applications", "audit"])) return;

        var apps = activeApps(p);
        var groups = {};
        apps.forEach(function (a) {
            var g = groups[a.assignee] || (groups[a.assignee] = { name: a.assignee, total: 0, by: {} });
            g.total++;
            g.by[a.status] = (g.by[a.status] || 0) + 1;
        });
        var rows = Object.keys(groups).map(function (k) { return groups[k]; });
        rows.sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });

        /* fold the tail past 7 into "Other" — never generate more marks */
        if (rows.length > 8) {
            var other = { name: "Other", total: 0, by: {} };
            rows.slice(7).forEach(function (g) {
                other.total += g.total;
                Object.keys(g.by).forEach(function (k) { other.by[k] = (other.by[k] || 0) + g.by[k]; });
            });
            rows = rows.slice(0, 7).concat([other]);
        }

        if (state.views.assignee === "table") {
            el.assigneeBody.appendChild(buildAggTable(
                ["Assignee"].concat(STATUSES.map(function (st) { return st.label; }), ["Total"]),
                rows.map(function (g) {
                    return [g.name].concat(STATUSES.map(function (st) { return fmt(g.by[st.key] || 0); }), [fmt(g.total)]);
                })
            ));
            return;
        }
        if (!rows.length) { emptyState(el.assigneeBody, "No cases in this period"); return; }

        var legend = div("chart-legend");
        STATUSES.forEach(function (st) {
            var e = div("legend-entry");
            e.appendChild(div("legend-key is-box sw-" + st.key));
            e.appendChild(div("legend-label", st.label));
            legend.appendChild(e);
        });
        el.assigneeBody.appendChild(legend);

        var W = Math.max(320, el.assigneeBody.clientWidth || 640);
        var rowH = 34, barH = 18;
        var m = { t: 4, r: 48, b: 26, l: Math.min(170, Math.max(90, Math.round(W * 0.22))) };
        var H = m.t + rows.length * rowH + m.b;
        var pw = W - m.l - m.r;
        var scale = axisScale(rows[0].total);

        var s = svgEl("svg", {
            class: "viz-svg", width: W, height: H, role: "img",
            "aria-label": "Cases by assignee, stacked by status"
        });

        for (var g = 0; g <= 4; g++) {
            var xv = scale.step * g;
            var gx = m.l + (xv / scale.max) * pw;
            if (g > 0) s.appendChild(svgEl("line", { class: "grid-line", x1: gx, x2: gx, y1: m.t, y2: H - m.b }));
            var tick = svgEl("text", { class: "axis-tick", x: gx, y: H - m.b + 16, "text-anchor": "middle" });
            tick.textContent = fmt(xv);
            s.appendChild(tick);
        }

        rows.forEach(function (row, i) {
            var y = m.t + i * rowH + (rowH - barH) / 2;
            var hit = svgEl("rect", {
                class: "row-hit", x: 0, y: m.t + i * rowH, width: W, height: rowH, rx: 6,
                tabindex: "0", role: "img",
                "aria-label": row.name + ": " + fmt(row.total) + " cases — " + STATUSES.map(function (st) {
                    return st.label + " " + (row.by[st.key] || 0);
                }).join(", ")
            });
            s.appendChild(hit);

            var name = svgEl("text", { class: "bar-name", x: m.l - 8, y: y + barH / 2 + 4, "text-anchor": "end" });
            name.textContent = row.name.length > 22 ? row.name.slice(0, 21) + "…" : row.name;
            s.appendChild(name);

            var x = m.l;
            STATUSES.forEach(function (st) {
                var c = row.by[st.key] || 0;
                if (!c) return;
                var w = (c / scale.max) * pw;
                s.appendChild(svgEl("rect", { class: "stack-seg seg-" + st.key, x: x, y: y, width: w, height: barH, "pointer-events": "none" }));
                x += w;
            });
            var val = svgEl("text", { class: "bar-value", x: x + 7, y: y + barH / 2 + 4 });
            val.textContent = fmt(row.total);
            s.appendChild(val);

            function tip(cx, cy) {
                showTip(row.name + " · " + fmt(row.total) + " cases",
                    STATUSES.filter(function (st) { return row.by[st.key]; }).map(function (st) {
                        return { swatch: "sw-" + st.key, value: fmt(row.by[st.key]), label: st.label };
                    }), cx, cy);
            }
            hit.addEventListener("pointermove", function (ev) { tip(ev.clientX, ev.clientY); });
            hit.addEventListener("pointerleave", hideTip);
            hit.addEventListener("focus", function () {
                var b = hit.getBoundingClientRect();
                tip(b.left + m.l, b.top);
            });
            hit.addEventListener("blur", hideTip);
        });
        s.appendChild(svgEl("line", { class: "axis-line", x1: m.l, x2: m.l, y1: m.t, y2: H - m.b }));

        el.assigneeBody.appendChild(s);
    }

    /* ================================================================
       Aggregation tables (chart "table view" twin)
       ================================================================ */
    function buildAggTable(headers, rows) {
        var wrap = div("table-scroll");
        var table = document.createElement("table");
        table.className = "viz-table";
        var thead = document.createElement("thead");
        var trh = document.createElement("tr");
        headers.forEach(function (h, i) {
            var th = document.createElement("th");
            th.textContent = h;
            if (i > 0) th.style.textAlign = "right";
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);
        var tbody = document.createElement("tbody");
        rows.forEach(function (r) {
            var tr = document.createElement("tr");
            r.forEach(function (c, i) {
                var td = document.createElement("td");
                if (i > 0) td.className = "num";
                td.textContent = c;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    /* ================================================================
       Filters & chrome
       ================================================================ */
    function rebuildAssigneeOptions() {
        var seen = {}, names = [];
        model.apps.forEach(function (a) {
            if (!seen[a.assignee]) { seen[a.assignee] = 1; names.push(a.assignee); }
        });
        names.sort(function (a, b) {
            if (a === UNASSIGNED) return 1;
            if (b === UNASSIGNED) return -1;
            return a.localeCompare(b);
        });
        var sig = names.join("\u0001");
        if (sig === rebuildAssigneeOptions._sig) return;
        rebuildAssigneeOptions._sig = sig;

        el.assigneeControl.textContent = "";
        [["all", "All assignees"]].concat(names.map(function (n) { return [n, n]; })).forEach(function (o) {
            var opt = document.createElement("option");
            opt.value = o[0];
            opt.textContent = o[1];
            el.assigneeControl.appendChild(opt);
        });
        el.assigneeControl.disabled = !names.length;
        if (state.assignee !== "all" && names.indexOf(state.assignee) === -1) state.assignee = "all";
        el.assigneeControl.value = state.assignee;
    }

    function syncFilterControls() {
        var daily = state.view === "daily";
        el.dateFrom.disabled = daily;
        el.dateTo.disabled = daily;
        el.dateClear.disabled = daily || (!state.from && !state.to);
        el.dateHint.hidden = !daily;
        el.viewControl.querySelectorAll("button").forEach(function (b) {
            var on = b.dataset.view === state.view;
            b.classList.toggle("is-selected", on);
            b.setAttribute("aria-selected", on ? "true" : "false");
        });
    }

    function renderMeta() {
        el.sampleBadge.hidden = !state.sample;
        if (state.lastUpdated) {
            var d = state.lastUpdated;
            var hh = d.getHours() % 12 || 12;
            var mm = String(d.getMinutes()).padStart(2, "0");
            var ap = d.getHours() >= 12 ? "PM" : "AM";
            el.lastUpdated.textContent = "Updated " + d.getDate() + " " + MONTHS[d.getMonth()] + ", " + hh + ":" + mm + " " + ap;
        }
    }

    function renderAll() {
        hideTip();
        rebuildAssigneeOptions();
        syncFilterControls();
        var p = currentPeriod();
        /* Sections render independently — one bad dataset can never blank
           the whole dashboard. */
        [renderMeta, renderKPIs, renderTrend, renderDonut, renderAssignee].forEach(function (fn) {
            try { fn(p); } catch (e) { console.error("[dashboard] render section failed", e); }
        });
    }

    function setRefreshing(on) {
        el.refreshBtn.disabled = on;
        el.dashboard.classList.toggle("is-refreshing", on);
    }

    function showBootError(message, detail) {
        el.boot.hidden = false;
        el.boot.textContent = "";
        el.boot.appendChild(div("boot-error-title", "Couldn't load live data"));
        el.boot.appendChild(div("boot-error-msg", message));
        if (detail) el.boot.appendChild(div("boot-error-detail", detail));
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-refresh";
        btn.textContent = "Retry";
        btn.addEventListener("click", function () {
            el.boot.hidden = true;
            if (state.inited) loadAll();
            else boot();
        });
        el.boot.appendChild(btn);
    }

    /* ================================================================
       Sample data (local preview outside Zoho Creator)
       Generated in the same raw shape the live reports return.
       ================================================================ */
    function mulberry32(seed) {
        return function () {
            seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
            var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function useSampleData() {
        var rnd = mulberry32(20260925);
        var assignees = ["Rahul Sharma", "Priya Nair", "Amit Verma", "Sneha Patil", ""];
        function creatorDate(d, withTime) {
            var s = String(d.getDate()).padStart(2, "0") + "-" + MONTHS[d.getMonth()] + "-" + d.getFullYear();
            if (withTime) s += " " + [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (x) { return String(x).padStart(2, "0"); }).join(":");
            return s;
        }
        var now = Date.now(), apps = [], audit = [], emails = [];
        for (var i = 0; i < 140; i++) {
            var id = "1635870000143" + String(i).padStart(5, "0");
            var t = now - Math.pow(rnd(), 1.5) * 200 * DAY;
            var name = assignees[Math.floor(rnd() * assignees.length)];
            audit.push({ NSDC_Partnership_Application_Form: { ID: id }, Action_field: "Submitted", Action_Time: creatorDate(new Date(t), true) });
            var status = "Submitted", roll = rnd();
            if (roll < 0.75) {
                t += (0.2 + rnd() * 6) * DAY;
                if (t < now) {
                    status = roll < 0.4 ? "Approved" : roll < 0.55 ? "Rejected" : "Sent Back";
                    audit.push({ NSDC_Partnership_Application_Form: { ID: id }, Action_field: status, Action_Time: creatorDate(new Date(t), true) });
                    if (status === "Sent Back" && rnd() < 0.5) {
                        t += (0.5 + rnd() * 4) * DAY;
                        if (t < now) {
                            status = "Resubmitted";
                            audit.push({ NSDC_Partnership_Application_Form: { ID: id }, Action_field: status, Action_Time: creatorDate(new Date(t), true) });
                        }
                    }
                }
            }
            apps.push({ ID: id, Status: status, Assignee: name ? { ID: "u" + name.length, zc_display_value: name } : "" });
        }
        for (var j = 0; j < 320; j++) {
            emails.push({ ID: String(9000 + j), Email_Sent_Date: creatorDate(new Date(now - Math.pow(rnd(), 1.4) * 200 * DAY), false) });
        }
        function ds(records) { return { records: records, truncated: false, error: false }; }
        state.datasets = { applications: ds(apps), audit: ds(audit), emails: ds(emails) };
        state.sample = true;
        state.lastUpdated = new Date();
        buildModel();
        renderAll();
    }

    /* ================================================================
       Controls & boot
       ================================================================ */
    function dateFromInput(v) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }

    function onDateChange() {
        var from = dateFromInput(el.dateFrom.value), to = dateFromInput(el.dateTo.value);
        if (from && to && from > to) {       // keep the range ordered
            var t = from; from = to; to = t;
            var v = el.dateFrom.value; el.dateFrom.value = el.dateTo.value; el.dateTo.value = v;
        }
        state.from = from;
        state.to = to;
        renderAll();
    }
    el.dateFrom.addEventListener("change", onDateChange);
    el.dateTo.addEventListener("change", onDateChange);
    el.dateClear.addEventListener("click", function () {
        el.dateFrom.value = "";
        el.dateTo.value = "";
        onDateChange();
    });

    el.viewControl.addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-view]");
        if (!btn || btn.dataset.view === state.view) return;
        state.view = btn.dataset.view;
        renderAll();
    });

    el.assigneeControl.addEventListener("change", function () {
        state.assignee = el.assigneeControl.value || "all";
        renderAll();
    });

    document.querySelectorAll(".view-toggle").forEach(function (tg) {
        tg.addEventListener("click", function (ev) {
            var btn = ev.target.closest("button[data-view]");
            if (!btn) return;
            var which = tg.dataset.for;
            if (state.views[which] === btn.dataset.view) return;
            state.views[which] = btn.dataset.view;
            tg.querySelectorAll("button").forEach(function (b) {
                b.classList.toggle("is-selected", b === btn);
            });
            var render = { donut: renderDonut, trend: renderTrend, assignee: renderAssignee }[which];
            if (render) render(currentPeriod());
        });
    });

    el.refreshBtn.addEventListener("click", function () {
        if (state.sample) { useSampleData(); return; }
        loadAll();
    });

    /* re-render charts on resize (debounced) */
    var resizeTimer = null;
    window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            var p = currentPeriod();
            if (state.views.trend === "chart") renderTrend(p);
            if (state.views.assignee === "chart") renderAssignee(p);
        }, 160);
    });

    function boot() {
        var settled = false;
        function once(fn) {
            return function () { if (settled) return; settled = true; fn.apply(null, arguments); };
        }

        /* Paint the dashboard shell right away — no connecting screen. */
        renderAll();

        /* Opened directly in a browser tab (not iframed by Creator):
           render clearly-badged sample data for layout preview only. */
        if (window.parent === window) { useSampleData(); return; }

        var C = window.ZOHO && ZOHO.CREATOR;
        if (!(C && C.DATA && C.UTIL && typeof C.UTIL.getInitParams === "function")) {
            showBootError("The Creator Widget SDK did not load. Check that widgetsdk-min.js is reachable.");
            return;
        }
        /* SDK v2 has no init(); getInitParams() confirms the Creator
           context and hands back the hosting app's link name. */
        var timer = setTimeout(once(function () {
            showBootError("Timed out connecting to the Creator Widget SDK. Reopen the widget or check your network.");
        }), CONFIG.initTimeoutMs);
        try {
            Promise.resolve(C.UTIL.getInitParams())
                .then(once(function (params) {
                    clearTimeout(timer);
                    state.inited = true;
                    if (params && params.appLinkName) CONFIG.appLinkName = params.appLinkName;
                    loadAll();
                }))
                .catch(once(function (err) {
                    clearTimeout(timer);
                    showBootError("The Creator Widget SDK failed to initialise.", errText(err));
                }));
        } catch (e) {
            once(function () {
                clearTimeout(timer);
                showBootError("The Creator Widget SDK threw an error.", errText(e));
            })();
        }
    }

    boot();
})();
