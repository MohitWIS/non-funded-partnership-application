/* =====================================================================
   Non-Funded Partnership Application — dashboard widget
   Fetches Zoho Creator reports via the Widget SDK (v2, v1 fallback)
   and renders KPIs + SVG charts. No external libraries.
   ===================================================================== */
(function () {
    "use strict";

    var CONFIG = {
        accountOwner: "itzoho_nsdcindia",
        appLinkName: "non-funded-partnership-application",
        reports: {
            main: "NSDC_Partnership_Application_Report",
            pending: "My_Pending_Cases",
            approved: "Approved_Cases",
            rejected: "Rejected_Cases",
            sentback: "Sent_Back_Cases",
            resubmitted: "Resubmitted_Cases",
            emails: "All_Emails"
        },
        pageSize: 200,
        maxPages: 10,          // up to 2,000 records per report
        initTimeoutMs: 9000,
        fetchTimeoutMs: 30000  // per-report cap so one hung fetch can't freeze the UI
    };

    /* Donut segment order — CVD-validated adjacency (do not reorder) */
    var STATUSES = [
        { key: "approved", label: "Approved", cls: "approved" },
        { key: "pending", label: "Pending", cls: "pending" },
        { key: "rejected", label: "Rejected", cls: "rejected" },
        { key: "resubmitted", label: "Resubmitted", cls: "resubmitted" },
        { key: "sentback", label: "Sent back", cls: "sentback" }
    ];

    var TILES = [
        { key: "total", label: "Total applications", ds: "main", chip: "chip-total", icon: "doc" },
        { key: "pending", label: "Pending cases", ds: "pending", chip: "chip-pending", icon: "clock" },
        { key: "approved", label: "Approved", ds: "approved", chip: "chip-approved", icon: "check" },
        { key: "rejected", label: "Rejected", ds: "rejected", chip: "chip-rejected", icon: "x" },
        { key: "sentback", label: "Sent back", ds: "sentback", chip: "chip-sentback", icon: "undo" },
        { key: "resubmitted", label: "Resubmitted", ds: "resubmitted", chip: "chip-resubmitted", icon: "redo" },
        { key: "emails", label: "Emails sent", ds: "emails", chip: "chip-emails", icon: "mail", spark: true }
    ];

    var ICONS = {
        doc: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6"],
        clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 3"],
        check: ["M20 6L9 17l-5-5"],
        x: ["M18 6L6 18", "M6 6l12 12"],
        undo: ["M9 14L4 9l5-5", "M20 20v-7a4 4 0 0 0-4-4H4"],
        redo: ["M1 4v6h6", "M3.51 15a9 9 0 1 0 2.13-9.36L1 10"],
        mail: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M22 6l-10 7L2 6"]
    };

    var state = {
        datasets: {},          // key -> { records, truncated, error, dateKey }
        range: "all",          // 'all' | '90' | '30' | '7'
        status: "all",         // 'all' | a STATUSES key — emphasis + record filter
        search: "",            // table text search
        tableLimit: 25,        // rows shown in the records table
        views: { donut: "chart", trend: "chart" },
        sample: false,
        inited: false,
        rendered: false,
        lastUpdated: null,
        trendFocus: -1
    };

    var nf = new Intl.NumberFormat("en-IN");
    function fmt(n) { return nf.format(n); }
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    var el = {
        boot: document.getElementById("boot-state"),
        dashboard: document.getElementById("dashboard"),
        kpiGrid: document.getElementById("kpi-grid"),
        donutBody: document.getElementById("donut-body"),
        trendBody: document.getElementById("trend-body"),
        trendSub: document.getElementById("trend-sub"),
        recentBody: document.getElementById("recent-body"),
        recentSub: document.getElementById("recent-sub"),
        sampleBadge: document.getElementById("sample-badge"),
        lastUpdated: document.getElementById("last-updated"),
        refreshBtn: document.getElementById("refresh-btn"),
        rangeControl: document.getElementById("range-control"),
        tip: document.getElementById("viz-tip")
    };

    /* ================================================================
       Data layer
       ================================================================ */
    function apiVersion() {
        if (window.ZOHO && ZOHO.CREATOR) {
            if (ZOHO.CREATOR.DATA && typeof ZOHO.CREATOR.DATA.getRecords === "function") return "v2";
            if (ZOHO.CREATOR.API && typeof ZOHO.CREATOR.API.getAllRecords === "function") return "v1";
        }
        return null;
    }

    function isNoData(err) {
        /* An empty report is data (count 0), not an error.
           v2 SDK: 9220 "No records exist in this report." · v1: 3100 · REST: 9280 */
        if (!err) return false;
        var rt = err.responseText;
        if (typeof rt === "string") { try { rt = JSON.parse(rt); } catch (e) { rt = null; } }
        var code = err.code != null ? err.code : (rt && rt.code);
        if (code == 3100 || code == 9220 || code == 9280) return true; // loose ==: SDK may send "9220"
        var msg = errText(err);
        try { msg += " " + JSON.stringify(err); } catch (e2) { }
        return /no records? exist|no (data|records)/i.test(msg);
    }

    function fetchReportV2(linkName) {
        /* Try with field_config:"all" first (includes system fields like
           Added_Time); if the SDK rejects that config, retry with defaults. */
        var variants = [{ field_config: "all" }, {}];
        function attempt(vi) {
            var out = [], pages = 0;
            function step(cursor) {
                var cfg = {
                    app_name: CONFIG.appLinkName,
                    report_name: linkName,
                    max_records: CONFIG.pageSize
                };
                Object.assign(cfg, variants[vi]);
                if (cursor) cfg.record_cursor = cursor;
                return ZOHO.CREATOR.DATA.getRecords(cfg).then(function (res) {
                    if (res && res.data && res.data.length) out = out.concat(res.data);
                    pages++;
                    var next = res && (res.record_cursor ||
                        (res.info && res.info.record_cursor) ||
                        (res.meta && res.meta.record_cursor));
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

    function fetchReportV1(linkName) {
        var out = [], page = 1;
        function step() {
            return ZOHO.CREATOR.API.getAllRecords({
                appName: CONFIG.appLinkName,
                reportName: linkName,
                page: page,
                pageSize: CONFIG.pageSize
            }).then(function (res) {
                var recs = (res && res.data) || [];
                out = out.concat(recs);
                if (recs.length === CONFIG.pageSize && page < CONFIG.maxPages) { page++; return step(); }
                return { records: out, truncated: recs.length === CONFIG.pageSize && page >= CONFIG.maxPages };
            });
        }
        return step();
    }

    function fetchReport(linkName) {
        var fn = apiVersion() === "v2" ? fetchReportV2 : fetchReportV1;
        return fn(linkName).catch(function (err) {
            if (isNoData(err)) return { records: [], truncated: false };
            throw err;
        });
    }

    function errText(err) {
        if (!err) return "Unknown error";
        if (typeof err === "string") return err;
        var rt = err.responseText;
        if (typeof rt === "string") { try { rt = JSON.parse(rt); } catch (e) { rt = null; } }
        var m = err.description || err.message || (rt && (rt.description || rt.message));
        if (m) return String(m);
        try { return JSON.stringify(err); } catch (e2) { return String(err); }
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

    function loadAll() {
        var keys = Object.keys(CONFIG.reports);
        setRefreshing(true);
        state.sample = false;
        var remaining = keys.length;
        /* Paint the dashboard immediately; each section fills in as its
           report arrives — there is no blocking loader screen. */
        if (!state.rendered) renderAll();
        keys.forEach(function (k) {
            withTimeout(fetchReport(CONFIG.reports[k]), CONFIG.fetchTimeoutMs, CONFIG.reports[k]).then(
                function (v) {
                    state.datasets[k] = {
                        records: v.records,
                        truncated: v.truncated,
                        error: false,
                        dateKey: detectDateKey(v.records)
                    };
                    done();
                },
                function (e) {
                    console.error("[dashboard] failed to fetch report " + CONFIG.reports[k], e);
                    state.datasets[k] = { records: [], truncated: false, error: true, dateKey: null };
                    done();
                }
            );
        });
        function done() {
            remaining--;
            state.lastUpdated = new Date();
            try { renderAll(); } catch (e) { console.error("[dashboard] render error", e); }
            if (remaining === 0) setRefreshing(false);
        }
    }

    /* ================================================================
       Dates & filtering
       ================================================================ */
    function parseDate(v) {
        if (!v) return null;
        if (v instanceof Date) return isNaN(v) ? null : v;
        if (typeof v !== "string") return null;
        var s = v.trim();
        if (!s) return null;
        // dd-MMM-yyyy [HH:mm[:ss]]
        var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (m) {
            var d = new Date(m[1] + " " + m[2] + " " + m[3] +
                (m[4] ? " " + m[4] + ":" + m[5] + ":" + (m[6] || "00") : ""));
            return isNaN(d) ? null : d;
        }
        // dd/MM/yyyy
        var m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m2) {
            var d2 = new Date(+m2[3], +m2[2] - 1, +m2[1]);
            return isNaN(d2) ? null : d2;
        }
        var d3 = new Date(s);
        return isNaN(d3) ? null : d3;
    }

    function detectDateKey(records) {
        if (!records || !records.length) return null;
        var sample = records.slice(0, 5);
        var keys = Object.keys(sample[0] || {});
        var exact = null, fuzzy = null;
        keys.forEach(function (k) {
            if (exact) return;
            if (/^added.?time$/i.test(k)) { exact = k; return; }
        });
        if (exact) return exact;
        keys.forEach(function (k) {
            if (fuzzy) return;
            if (/date|time/i.test(k) && !/format|zone/i.test(k)) {
                var ok = sample.some(function (r) { return parseDate(r[k]); });
                if (ok) fuzzy = k;
            }
        });
        return fuzzy;
    }

    function rangeCutoff() {
        if (state.range === "all") return null;
        var d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (parseInt(state.range, 10) - 1));
        return d;
    }

    function filteredRecords(ds) {
        if (!ds) return [];
        var c = rangeCutoff();
        if (!c || !ds.dateKey) return ds.records;
        return ds.records.filter(function (r) {
            var d = parseDate(r[ds.dateKey]);
            return d && d >= c;
        });
    }

    /* ================================================================
       Aggregation — time buckets
       ================================================================ */
    function buildBuckets(records, dateKey) {
        var buckets = [];
        var now = new Date();
        var i, start, end;

        function push(s, e, label) { buckets.push({ start: s, end: e, label: label, count: 0 }); }

        if (state.range === "7" || state.range === "30") {
            var days = parseInt(state.range, 10);
            for (i = days - 1; i >= 0; i--) {
                start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
                end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
                push(start, end, start.getDate() + " " + MONTHS[start.getMonth()]);
            }
        } else if (state.range === "90") {
            var anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90);
            for (i = 0; i < 13; i++) {
                start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i * 7);
                end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + (i + 1) * 7);
                push(start, end, start.getDate() + " " + MONTHS[start.getMonth()]);
            }
        } else {
            for (i = 11; i >= 0; i--) {
                start = new Date(now.getFullYear(), now.getMonth() - i, 1);
                end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
                push(start, end, MONTHS[start.getMonth()] + " '" + String(start.getFullYear()).slice(2));
            }
        }

        if (dateKey) {
            records.forEach(function (r) {
                var d = parseDate(r[dateKey]);
                if (!d) return;
                for (var b = 0; b < buckets.length; b++) {
                    if (d >= buckets[b].start && d < buckets[b].end) { buckets[b].count++; break; }
                }
            });
        }
        return buckets;
    }

    function granularityLabel() {
        if (state.range === "7") return "Daily · last 7 days";
        if (state.range === "30") return "Daily · last 30 days";
        if (state.range === "90") return "Weekly · last 90 days";
        return "Monthly · last 12 months";
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
    function iconSvg(name, size) {
        var s = svgEl("svg", {
            viewBox: "0 0 24 24", width: size || 15, height: size || 15,
            fill: "none", stroke: "currentColor", "stroke-width": "2",
            "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"
        });
        (ICONS[name] || []).forEach(function (d) { s.appendChild(svgEl("path", { d: d })); });
        return s;
    }

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
        moveTip(x, y);
    }
    function moveTip(x, y) {
        var pad = 12, r = el.tip.getBoundingClientRect();
        var nx = Math.min(x + pad, window.innerWidth - r.width - 8);
        var ny = y - r.height - pad;
        if (ny < 8) ny = y + pad;
        el.tip.style.left = Math.max(8, nx) + "px";
        el.tip.style.top = ny + "px";
    }
    function hideTip() { el.tip.hidden = true; }

    /* ================================================================
       Render — KPI tiles
       ================================================================ */
    function renderKPIs() {
        el.kpiGrid.textContent = "";
        TILES.forEach(function (t) {
            var ds = state.datasets[t.ds];
            var loading = !ds;
            if (loading) ds = { records: [], error: false, truncated: false, dateKey: null };
            var recs = loading ? [] : filteredRecords(ds);
            var tile = div("kpi-tile");
            tile.setAttribute("role", "group");
            if (state.status !== "all" && t.key !== "total" && t.key !== "emails") {
                tile.classList.add(t.key === state.status ? "is-active" : "is-dimmed");
            }

            var top = div("kpi-top");
            var chip = div("kpi-chip " + t.chip);
            chip.appendChild(iconSvg(t.icon));
            top.appendChild(chip);
            top.appendChild(div("kpi-label", t.label));
            tile.appendChild(top);

            var valueText = loading ? "…" : ds.error ? "—" : fmt(recs.length) + (ds.truncated ? "+" : "");
            tile.appendChild(div("kpi-value" + (loading ? " is-loading" : ""), valueText));
            tile.setAttribute("aria-label", t.label + ": " + valueText);

            if (loading) {
                tile.appendChild(div("kpi-note", "Loading…"));
            } else if (ds.error) {
                tile.appendChild(div("kpi-note is-error", "Couldn't load report"));
            } else if (state.range !== "all" && !ds.dateKey) {
                tile.appendChild(div("kpi-note", "All time (no date field)"));
            }

            if (t.spark && !loading && !ds.error && ds.dateKey) {
                tile.appendChild(renderSparkline(ds));
            }
            el.kpiGrid.appendChild(tile);
        });
    }

    function renderSparkline(ds) {
        var saved = state.range;
        state.range = "all";                       // sparkline is always 12 months
        var buckets = buildBuckets(ds.records, ds.dateKey);
        state.range = saved;

        var w = 120, h = 26, max = 1;
        buckets.forEach(function (b) { max = Math.max(max, b.count); });
        var box = div("kpi-spark");
        var s = svgEl("svg", { class: "viz-svg", width: w, height: h, "aria-hidden": "true" });
        var pts = buckets.map(function (b, i) {
            var x = (i / (buckets.length - 1)) * (w - 8) + 4;
            var y = h - 4 - (b.count / max) * (h - 9);
            return [x, y];
        });
        var line = svgEl("polyline", {
            class: "spark-line",
            points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" ")
        });
        s.appendChild(line);
        var last = pts[pts.length - 1];
        s.appendChild(svgEl("circle", { class: "spark-dot", cx: last[0], cy: last[1], r: 3 }));
        box.appendChild(s);
        return box;
    }

    /* ================================================================
       Render — donut (status distribution)
       ================================================================ */
    function statusCounts() {
        return STATUSES.map(function (st) {
            var ds = state.datasets[st.key];
            return {
                key: st.key, label: st.label, cls: st.cls,
                count: ds && !ds.error ? filteredRecords(ds).length : 0,
                error: !!(ds && ds.error),
                loading: !ds
            };
        });
    }

    function renderDonut() {
        el.donutBody.textContent = "";
        var items = statusCounts();
        var total = items.reduce(function (a, b) { return a + b.count; }, 0);

        if (state.views.donut === "table") {
            el.donutBody.appendChild(buildAggTable(
                ["Status", "Cases", "Share"],
                items.map(function (it) {
                    return [it.label, fmt(it.count), total ? Math.round((it.count / total) * 100) + "%" : "0%"];
                })
            ));
            return;
        }

        if (!total) {
            var anyLoading = items.some(function (it) { return it.loading; });
            el.donutBody.appendChild(div("chart-empty", anyLoading ? "Loading…" : "No cases in this period"));
            return;
        }

        var size = 188, cx = size / 2, cy = size / 2, R = 86, r = 57;
        var wrap = div("donut-wrap");
        var box = div("donut-svg-box");
        var s = svgEl("svg", {
            class: "viz-svg", width: size, height: size, role: "img",
            "aria-label": "Case status distribution, " + fmt(total) + " cases total"
        });

        var segs = [];
        var angle = -Math.PI / 2;
        items.forEach(function (it) {
            if (!it.count) return;
            var frac = it.count / total;
            var a0 = angle, a1 = angle + frac * Math.PI * 2;
            angle = a1;
            var path = svgEl("path", {
                d: donutArc(cx, cy, R, r, a0, frac >= 0.9999 ? a0 + Math.PI * 1.9999 : a1),
                class: "donut-seg seg-" + it.cls,
                tabindex: "0",
                role: "img",
                "aria-label": it.label + ": " + fmt(it.count) + " cases (" + Math.round(frac * 100) + "%)"
            });
            if (state.status !== "all" && it.key !== state.status) path.classList.add("is-muted");
            var pct = Math.round(frac * 100);
            function activate(x, y) {
                segs.forEach(function (p) { p.style.opacity = p === path ? "1" : "0.35"; });
                centerBig.textContent = fmt(it.count);
                centerSmall.textContent = it.label + " · " + pct + "%";
                showTip(it.label, [{ swatch: "sw-" + it.cls, value: fmt(it.count) + " cases", label: pct + "%" }], x, y);
            }
            function deactivate() {
                segs.forEach(function (p) { p.style.opacity = ""; });
                centerDefault();
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
        var center = div("donut-center");
        var centerBig = div("big", "");
        var centerSmall = div("small", "");
        center.appendChild(centerBig);
        center.appendChild(centerSmall);
        box.appendChild(center);
        wrap.appendChild(box);

        function centerDefault() {
            if (state.status !== "all") {
                var sel = null;
                items.forEach(function (it) { if (it.key === state.status) sel = it; });
                if (sel) {
                    centerBig.textContent = sel.loading ? "…" : fmt(sel.count);
                    centerSmall.textContent = sel.label + " · " + Math.round((sel.count / total) * 100) + "%";
                    return;
                }
            }
            centerBig.textContent = fmt(total);
            centerSmall.textContent = "total cases";
        }
        centerDefault();

        /* legend with visible counts (relief for low-contrast hues) */
        var legend = div("donut-legend");
        items.forEach(function (it) {
            var row = div("legend-row");
            row.appendChild(div("legend-swatch sw-" + it.cls));
            row.appendChild(div("legend-name", it.label + (it.error ? " (failed to load)" : "")));
            row.appendChild(div("legend-count", it.loading ? "…" : it.error ? "—" : fmt(it.count)));
            row.appendChild(div("legend-pct", total && !it.error ? Math.round((it.count / total) * 100) + "%" : ""));
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
       Render — trend (applications over time)
       ================================================================ */
    function axisScale(dataMax) {
        var target = Math.max(1, dataMax) / 4;
        var p = Math.pow(10, Math.floor(Math.log10(target)));
        var f = target / p;
        var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
        while (step * 4 < dataMax) step *= 2;
        return { max: step * 4, step: step };
    }

    function renderTrend() {
        el.trendBody.textContent = "";
        var statusLabel = "";
        if (state.status !== "all") {
            STATUSES.forEach(function (st) { if (st.key === state.status) statusLabel = st.label + " · "; });
        }
        el.trendSub.textContent = statusLabel + granularityLabel();
        var dsKey = state.status === "all" ? "main" : state.status;
        var ds = state.datasets[dsKey];

        if (!ds) {
            el.trendBody.appendChild(div("chart-empty", "Loading…"));
            return;
        }
        if (ds.error) {
            el.trendBody.appendChild(div("chart-empty", "Couldn't load " + CONFIG.reports[dsKey]));
            return;
        }
        if (!ds.dateKey) {
            el.trendBody.appendChild(div("chart-empty", "No date field found in the report, so a time trend can't be drawn"));
            return;
        }

        var buckets = buildBuckets(ds.records, ds.dateKey);

        if (state.views.trend === "table") {
            el.trendBody.appendChild(buildAggTable(
                ["Period", "Applications"],
                buckets.map(function (b) { return [b.label, fmt(b.count)]; })
            ));
            return;
        }

        var dataMax = buckets.reduce(function (a, b) { return Math.max(a, b.count); }, 0);
        if (!dataMax) {
            el.trendBody.appendChild(div("chart-empty", "No applications in this period"));
            return;
        }

        var W = Math.max(320, el.trendBody.clientWidth || 520);
        var H = 236;
        var m = { t: 14, r: 52, b: 26, l: 40 };
        var pw = W - m.l - m.r, ph = H - m.t - m.b;
        var scale = axisScale(dataMax);

        var s = svgEl("svg", {
            class: "viz-svg", width: W, height: H, tabindex: "0", role: "img",
            "aria-label": "Applications received, " + granularityLabel().toLowerCase()
        });

        /* gridlines + y ticks */
        for (var g = 0; g <= 4; g++) {
            var yv = scale.step * g;
            var y = m.t + ph - (yv / scale.max) * ph;
            if (g > 0) s.appendChild(svgEl("line", { class: "grid-line", x1: m.l, x2: m.l + pw, y1: y, y2: y }));
            var tick = svgEl("text", { class: "axis-tick", x: m.l - 8, y: y + 3.5, "text-anchor": "end" });
            tick.textContent = fmt(yv);
            s.appendChild(tick);
        }
        s.appendChild(svgEl("line", { class: "axis-line", x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph }));

        var n = buckets.length;
        function px(i) { return m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw); }
        function py(c) { return m.t + ph - (c / scale.max) * ph; }
        var pts = buckets.map(function (b, i) { return { x: px(i), y: py(b.count), b: b }; });

        /* x labels (skip to avoid collisions, anchored to the last) */
        var maxLabels = Math.max(2, Math.floor(pw / 58));
        var skip = Math.ceil(n / maxLabels);
        pts.forEach(function (p, i) {
            if ((n - 1 - i) % skip !== 0) return;
            var t = svgEl("text", { class: "axis-tick", x: p.x, y: m.t + ph + 17, "text-anchor": "middle" });
            t.textContent = p.b.label;
            s.appendChild(t);
        });

        /* area + line */
        var lineD = pts.map(function (p, i) { return (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1); }).join(" ");
        var areaD = lineD + " L" + pts[n - 1].x.toFixed(1) + " " + (m.t + ph) + " L" + pts[0].x.toFixed(1) + " " + (m.t + ph) + " Z";
        s.appendChild(svgEl("path", { class: "trend-area", d: areaD }));
        s.appendChild(svgEl("path", { class: "trend-line", d: lineD }));

        /* endpoint marker + direct label (selective labeling) */
        var last = pts[n - 1];
        s.appendChild(svgEl("circle", { class: "trend-dot", cx: last.x, cy: last.y, r: 4.5 }));
        var endLab = svgEl("text", { class: "end-label", x: last.x + 9, y: last.y + 4 });
        endLab.textContent = fmt(last.b.count);
        s.appendChild(endLab);

        /* hover layer: crosshair + tooltip, keyboard accessible */
        var crossh = svgEl("line", { class: "crosshair", y1: m.t, y2: m.t + ph, x1: 0, x2: 0, visibility: "hidden" });
        var hoverDot = svgEl("circle", { class: "hover-dot", r: 4.5, visibility: "hidden" });
        s.appendChild(crossh);
        s.appendChild(hoverDot);

        function focusIndex(i, clientX, clientY) {
            i = Math.max(0, Math.min(n - 1, i));
            state.trendFocus = i;
            var p = pts[i];
            crossh.setAttribute("x1", p.x); crossh.setAttribute("x2", p.x);
            crossh.setAttribute("visibility", "visible");
            hoverDot.setAttribute("cx", p.x); hoverDot.setAttribute("cy", p.y);
            hoverDot.setAttribute("visibility", "visible");
            var rect = s.getBoundingClientRect();
            showTip(p.b.label,
                [{ swatch: "sw-series1", value: fmt(p.b.count), label: "applications" }],
                clientX != null ? clientX : rect.left + p.x,
                clientY != null ? clientY : rect.top + p.y);
        }
        function clearFocus() {
            crossh.setAttribute("visibility", "hidden");
            hoverDot.setAttribute("visibility", "hidden");
            hideTip();
        }

        var overlay = svgEl("rect", { x: m.l, y: m.t, width: pw, height: ph, fill: "transparent" });
        overlay.addEventListener("pointermove", function (ev) {
            var rect = s.getBoundingClientRect();
            var x = ev.clientX - rect.left;
            var best = 0, bd = Infinity;
            pts.forEach(function (p, i) { var d = Math.abs(p.x - x); if (d < bd) { bd = d; best = i; } });
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
       Render — recent applications table
       ================================================================ */
    function cellText(v) {
        if (v == null) return "";
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(", ");
        if (typeof v === "object") {
            return v.zc_display_value || v.display_value ||
                [v.first_name, v.last_name].filter(Boolean).join(" ") || "";
        }
        return "";
    }

    function normalizeStatus(s) {
        if (!s) return null;
        var v = String(s).toLowerCase();
        if (/resubmit/.test(v)) return "resubmitted";
        if (/sent.?back|send.?back|return/.test(v)) return "sentback";
        if (/approv/.test(v)) return "approved";
        if (/reject|declin/.test(v)) return "rejected";
        if (/pend|progress|review|await|submit|open/.test(v)) return "pending";
        return null;
    }

    function pickColumns(records) {
        if (!records.length) return [];
        var keys = Object.keys(records[0]).filter(function (k) {
            return k !== "ID" && !/^\$/.test(k);
        });
        var cols = [], used = {};
        function take(re, max) {
            var got = 0;
            keys.forEach(function (k) {
                if (got >= max || used[k]) return;
                if (re.test(k) && cellText(records[0][k]) !== "") { cols.push(k); used[k] = true; got++; }
            });
        }
        take(/name|organization|org|company|applicant|title|partner/i, 2);
        take(/email/i, 1);
        take(/phone|mobile|contact/i, 1);
        take(/state|district|city|region/i, 1);
        take(/status|stage/i, 1);
        keys.forEach(function (k) {
            if (cols.length >= 6 || used[k]) return;
            if (/date|time/i.test(k)) return;
            if (cellText(records[0][k]) !== "") { cols.push(k); used[k] = true; }
        });
        return cols;
    }

    function renderRecent() {
        el.recentBody.textContent = "";
        var dsKey = state.status === "all" ? "main" : state.status;
        var ds = state.datasets[dsKey];
        if (!ds) {
            el.recentSub.textContent = "Loading…";
            el.recentBody.appendChild(div("chart-empty", "Loading…"));
            return;
        }
        if (ds.error) {
            el.recentSub.textContent = "";
            el.recentBody.appendChild(div("chart-empty", "Couldn't load " + CONFIG.reports[dsKey]));
            return;
        }
        var recs = filteredRecords(ds).slice();
        if (ds.dateKey) {
            recs.sort(function (a, b) {
                return (parseDate(b[ds.dateKey]) || 0) - (parseDate(a[ds.dateKey]) || 0);
            });
        }
        var cols = pickColumns(recs);

        /* text search across the visible columns */
        var q = state.search.trim().toLowerCase();
        if (q) {
            recs = recs.filter(function (r) {
                for (var i = 0; i < cols.length; i++) {
                    if (cellText(r[cols[i]]).toLowerCase().indexOf(q) !== -1) return true;
                }
                return false;
            });
        }
        if (!recs.length) {
            el.recentSub.textContent = "0 records";
            el.recentBody.appendChild(div("chart-empty",
                q ? "No records match “" + state.search + "”" : "No applications in this period"));
            return;
        }
        var rows = recs.slice(0, state.tableLimit);
        el.recentSub.textContent = "Showing " + fmt(rows.length) + " of " + fmt(recs.length) + " records";

        var table = document.createElement("table");
        table.className = "viz-table";
        var thead = document.createElement("thead");
        var trh = document.createElement("tr");
        cols.concat(ds.dateKey ? ["__date"] : []).forEach(function (c) {
            var th = document.createElement("th");
            th.textContent = c === "__date" ? "Added" : c.replace(/_/g, " ");
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);

        var tbody = document.createElement("tbody");
        rows.forEach(function (r) {
            var tr = document.createElement("tr");
            cols.forEach(function (c) {
                var td = document.createElement("td");
                var text = cellText(r[c]);
                var stKey = /status|stage/i.test(c) ? normalizeStatus(text) : null;
                if (stKey) {
                    var pill = document.createElement("span");
                    pill.className = "status-pill";
                    var dot = document.createElement("span");
                    dot.className = "dot sw-" + stKey;
                    pill.appendChild(dot);
                    var lbl = document.createElement("span");
                    lbl.textContent = text;
                    pill.appendChild(lbl);
                    td.appendChild(pill);
                } else {
                    td.textContent = text;
                }
                tr.appendChild(td);
            });
            if (ds.dateKey) {
                var tdd = document.createElement("td");
                var d = parseDate(r[ds.dateKey]);
                tdd.textContent = d ? d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() : "";
                tr.appendChild(tdd);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        el.recentBody.appendChild(table);

        if (recs.length > rows.length) {
            var foot = div("table-foot");
            var more = document.createElement("button");
            more.type = "button";
            more.className = "btn-refresh";
            more.textContent = "Show 25 more (" + fmt(recs.length - rows.length) + " remaining)";
            more.addEventListener("click", function () {
                state.tableLimit += 25;
                renderRecent();
            });
            foot.appendChild(more);
            el.recentBody.appendChild(foot);
        }
    }

    /* ================================================================
       Aggregation tables (chart "table view" twin)
       ================================================================ */
    function buildAggTable(headers, rows) {
        var table = document.createElement("table");
        table.className = "viz-table";
        var thead = document.createElement("thead");
        var trh = document.createElement("tr");
        headers.forEach(function (h) {
            var th = document.createElement("th");
            th.textContent = h;
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
        return table;
    }

    /* ================================================================
       Meta / chrome
       ================================================================ */
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
        el.boot.hidden = true;
        el.dashboard.hidden = false;
        state.rendered = true;
        /* Sections render independently — one bad dataset can never blank
           the whole dashboard. */
        [renderMeta, renderKPIs, renderDonut, renderTrend, renderRecent].forEach(function (fn) {
            try { fn(); } catch (e) { console.error("[dashboard] render section failed", e); }
        });
    }

    function setRefreshing(on) {
        el.refreshBtn.disabled = on;
        if (state.rendered) el.dashboard.classList.toggle("is-refreshing", on);
    }

    /* ================================================================
       Sample data (local preview outside Zoho Creator)
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
        var orgs = ["Skill Bridge Foundation", "Prayaas Livelihood Trust", "TechServe Academy",
            "Gramin Vikas Sansthan", "Udaan Skill Centre", "Nirmaan Education Society",
            "Karma Skilling Pvt Ltd", "Sahyog Welfare Trust", "Disha Training Institute",
            "Jyoti Rural Foundation"];
        var states = ["Maharashtra", "Karnataka", "Uttar Pradesh", "Tamil Nadu", "Delhi",
            "Gujarat", "Rajasthan", "Bihar", "Odisha", "Assam"];
        var statusPool = [];
        [["Approved", 30], ["Pending", 26], ["Rejected", 12], ["Resubmitted", 16], ["Sent Back", 10]]
            .forEach(function (p) { for (var i = 0; i < p[1]; i++) statusPool.push(p[0]); });

        function creatorDate(d) {
            return d.getDate() + "-" + MONTHS[d.getMonth()] + "-" + d.getFullYear() + " " +
                String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":00";
        }

        var now = Date.now(), main = [];
        for (var i = 0; i < 230; i++) {
            var age = Math.pow(rnd(), 1.6) * 360;      // skew recent
            var d = new Date(now - age * 86400000);
            var org = orgs[Math.floor(rnd() * orgs.length)];
            main.push({
                ID: String(1000 + i),
                Organization_Name: org,
                State: states[Math.floor(rnd() * states.length)],
                Email: org.toLowerCase().replace(/[^a-z]+/g, ".") + "@example.org",
                Status: statusPool[Math.floor(rnd() * statusPool.length)],
                Added_Time: creatorDate(d)
            });
        }
        var emails = [];
        for (var j = 0; j < 540; j++) {
            var ed = new Date(now - Math.pow(rnd(), 1.4) * 360 * 86400000);
            emails.push({ ID: String(9000 + j), Subject: "Application update", Added_Time: creatorDate(ed) });
        }

        function ds(records) { return { records: records, truncated: false, error: false, dateKey: "Added_Time" }; }
        function byStatus(st) { return main.filter(function (r) { return r.Status === st; }); }

        state.datasets = {
            main: ds(main),
            pending: ds(byStatus("Pending")),
            approved: ds(byStatus("Approved")),
            rejected: ds(byStatus("Rejected")),
            sentback: ds(byStatus("Sent Back")),
            resubmitted: ds(byStatus("Resubmitted")),
            emails: ds(emails)
        };
        state.sample = true;
        state.lastUpdated = new Date();
        renderAll();
    }

    /* ================================================================
       Controls & boot
       ================================================================ */
    el.rangeControl.addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-range]");
        if (!btn || btn.dataset.range === state.range) return;
        state.range = btn.dataset.range;
        state.tableLimit = 25;
        el.rangeControl.querySelectorAll("button").forEach(function (b) {
            b.classList.toggle("is-selected", b === btn);
        });
        if (state.rendered) { renderKPIs(); renderDonut(); renderTrend(); renderRecent(); }
    });

    var statusControl = document.getElementById("status-control");
    statusControl.addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-status]");
        if (!btn || btn.dataset.status === state.status) return;
        state.status = btn.dataset.status;
        state.tableLimit = 25;
        statusControl.querySelectorAll("button").forEach(function (b) {
            b.classList.toggle("is-selected", b === btn);
        });
        if (state.rendered) { renderKPIs(); renderDonut(); renderTrend(); renderRecent(); }
    });

    var searchInput = document.getElementById("recent-search");
    var searchTimer = null;
    searchInput.addEventListener("input", function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
            state.search = searchInput.value || "";
            state.tableLimit = 25;
            if (state.rendered) renderRecent();
        }, 150);
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
            if (which === "donut") renderDonut(); else renderTrend();
        });
    });

    el.refreshBtn.addEventListener("click", function () {
        if (state.sample) { useSampleData(); return; }
        loadAll();
    });

    /* re-render charts on resize (debounced) */
    var resizeTimer = null;
    window.addEventListener("resize", function () {
        if (!state.rendered) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            if (state.views.trend === "chart") renderTrend();
        }, 160);
    });


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

        var hasV2 = window.ZOHO && ZOHO.CREATOR && ZOHO.CREATOR.DATA && ZOHO.CREATOR.UTIL &&
            typeof ZOHO.CREATOR.UTIL.getInitParams === "function";
        var hasV1 = window.ZOHO && ZOHO.CREATOR && typeof ZOHO.CREATOR.init === "function";

        if (hasV2) {
            /* SDK v2 has no init(); getInitParams() confirms the Creator
               context and hands back the hosting app's link name. */
            var timer = setTimeout(once(function () {
                showBootError("Timed out connecting to the Creator Widget SDK. Reopen the widget or check your network.");
            }), CONFIG.initTimeoutMs);
            try {
                Promise.resolve(ZOHO.CREATOR.UTIL.getInitParams())
                    .then(once(function (params) {
                        clearTimeout(timer);
                        state.inited = true;
                        console.log("[dashboard] init params", params);
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
        } else if (hasV1) {
            var timer1 = setTimeout(once(function () {
                showBootError("Timed out connecting to the Creator Widget SDK. Reopen the widget or check your network.");
            }), CONFIG.initTimeoutMs);
            ZOHO.CREATOR.init()
                .then(once(function () { state.inited = true; clearTimeout(timer1); loadAll(); }))
                .catch(once(function (err) {
                    clearTimeout(timer1);
                    showBootError("The Creator Widget SDK failed to initialise.", errText(err));
                }));
        } else {
            showBootError("The Creator Widget SDK did not load. Check that widgetsdk-min.js is reachable.");
        }
    }

    boot();
})();
