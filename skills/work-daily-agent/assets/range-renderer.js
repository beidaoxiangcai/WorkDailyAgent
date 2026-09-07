(function () {
  "use strict";

  var range = JSON.parse(document.getElementById("workdaily-range-data").textContent);
  var loadedDays = new Map();
  var loadingDays = new Map();
  var palettes = [
    { main: "#3478df", surface: "#dceaff", text: "#1455b8" },
    { main: "#22a9a5", surface: "#d9f1ef", text: "#147d79" },
    { main: "#7eb64d", surface: "#e5f1d9", text: "#527f2d" },
    { main: "#9259e8", surface: "#eadffd", text: "#6d35c7" },
    { main: "#d16b68", surface: "#f8e1df", text: "#a84542" },
    { main: "#d49735", surface: "#f8ead2", text: "#99671b" }
  ];
  var idlePalette = { main: "#a6a6aa", surface: "#e6e6e8", text: "#66666c" };

  window.WorkDailyRangeData = {
    register: function (date, payload) {
      loadedDays.set(date, payload);
    }
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function duration(milliseconds) {
    var seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return seconds + "s";
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "min";
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return rest ? hours + "h " + rest + "min" : hours + "h";
  }

  function percentage(value) {
    return (value * 100).toFixed(2) + "%";
  }

  function clock(timestamp, timezone) {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(timestamp * 1000));
  }

  function stableHash(value) {
    var hash = 0;
    Array.from(value).forEach(function (character) {
      hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    });
    return hash;
  }

  function palette(key, app) {
    if (key === "__system_idle__") return idlePalette;
    var identity = (key + " " + app).toLowerCase();
    if (identity.includes("xcode")) return palettes[0];
    if (identity.includes("chatgpt") || identity.includes("openai")) return palettes[1];
    if (identity.includes("wechat") || identity.includes("微信")) return palettes[2];
    if (identity.includes("sourcetree")) return palettes[3];
    return palettes[stableHash(key) % palettes.length];
  }

  function mixWithWhite(hex, ratio) {
    var value = hex.replace("#", "");
    return "#" + [0, 2, 4].map(function (offset) {
      var channel = parseInt(value.slice(offset, offset + 2), 16);
      return Math.round(channel + (255 - channel) * ratio).toString(16).padStart(2, "0");
    }).join("");
  }

  function dayStart(date) {
    return Date.parse(date + "T00:00:00+08:00") / 1000;
  }

  function loadDay(day) {
    if (loadedDays.has(day.date)) return Promise.resolve(loadedDays.get(day.date));
    if (loadingDays.has(day.date)) return loadingDays.get(day.date);
    var promise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = day.data_path;
      script.onload = function () {
        script.remove();
        if (loadedDays.has(day.date)) resolve(loadedDays.get(day.date));
        else reject(new Error("日期数据未注册"));
      };
      script.onerror = function () {
        script.remove();
        reject(new Error("无法读取 " + day.data_path));
      };
      document.head.appendChild(script);
    }).finally(function () {
      loadingDays.delete(day.date);
    });
    loadingDays.set(day.date, promise);
    return promise;
  }

  function createAxis(startHour) {
    var axis = element("div", "axis");
    for (var index = 0; index < 7; index += 1) {
      var hour = startHour + index * 2;
      var tick = element("div", "axis-tick");
      tick.style.left = (index / 6) * 100 + "%";
      tick.appendChild(element("span", "", String(hour).padStart(2, "0") + ":00"));
      axis.appendChild(tick);
    }
    return axis;
  }

  function renderTimeRange(data, startHour) {
    var startOfDay = dayStart(data.date);
    var rangeStart = startOfDay + startHour * 3600;
    var rangeEnd = rangeStart + 12 * 3600;
    var wrapper = element("div", "range");
    wrapper.appendChild(element(
      "div",
      "range-title",
      String(startHour).padStart(2, "0") + ":00 – " +
        String(startHour + 12).padStart(2, "0") + ":00"
    ));
    wrapper.appendChild(createAxis(startHour));
    var track = element("div", "track");

    data.activity_blocks.forEach(function (block) {
      var start = Math.max(block.start_ts, rangeStart);
      var end = Math.min(block.end_ts, rangeEnd);
      if (end <= start) return;
      var colors = palette(block.key, block.app);
      var visibleTitles = block.titles.filter(function (title) {
        return title.start_ts < end && title.end_ts > start;
      });
      var event = element("div", "event" + (visibleTitles.length > 1 ? "" : " single"));
      event.style.left = ((start - rangeStart) / 43200) * 100 + "%";
      event.style.width = ((end - start) / 43200) * 100 + "%";
      event.style.borderColor = colors.main;
      event.style.backgroundColor = colors.surface;
      event.title = block.app + "\n" + clock(start, data.timezone) + "–" +
        clock(end, data.timezone) + " · " + duration((end - start) * 1000);
      var app = element("div", "event-app", block.app);
      app.style.color = colors.text;
      event.appendChild(app);

      if (visibleTitles.length > 1) {
        var titleTrack = element("div", "title-track");
        visibleTitles.forEach(function (title, index) {
          var titleStart = Math.max(title.start_ts, start);
          var titleEnd = Math.min(title.end_ts, end);
          if (titleEnd <= titleStart) return;
          var segment = element("div", "title-segment");
          segment.style.left = ((titleStart - start) / (end - start)) * 100 + "%";
          segment.style.width = ((titleEnd - titleStart) / (end - start)) * 100 + "%";
          var ratio = [0.72, 0.18, 0.5, 0.32][index % 4];
          segment.style.backgroundColor = mixWithWhite(colors.main, ratio);
          segment.style.color = ratio >= 0.5 ? "#111827" : "#ffffff";
          segment.title = block.app + "\n" + (title.title || "(无标题)") + "\n" +
            clock(titleStart, data.timezone) + "–" + clock(titleEnd, data.timezone) +
            " · " + duration((titleEnd - titleStart) * 1000);
          segment.appendChild(element("span", "", title.title || "(无标题)"));
          titleTrack.appendChild(segment);
        });
        event.appendChild(titleTrack);
      }
      track.appendChild(event);
    });
    wrapper.appendChild(track);
    return wrapper;
  }

  function renderUsage(data, className) {
    var wrapper = element("div", className || "range-usage");
    if (!data.usage.length) {
      wrapper.appendChild(element("div", "empty", "暂无应用使用数据"));
      return wrapper;
    }
    var stops = [];
    var offset = 0;
    data.usage.forEach(function (item) {
      var colors = palette(item.key, item.app);
      var end = offset + item.ratio * 100;
      stops.push(colors.main + " " + offset + "% " + end + "%");
      offset = end;
    });
    var donut = element("div", "donut");
    donut.style.background = "conic-gradient(" + stops.join(", ") + ")";
    donut.setAttribute("role", "img");
    donut.setAttribute("aria-label", "应用使用时长占比");
    wrapper.appendChild(donut);

    var list = element("div", className === "range-usage" ? "usage-list" : "day-usage-list");
    data.usage.forEach(function (item) {
      var colors = palette(item.key, item.app);
      if (!item.details) {
        var row = element("div", "usage-row");
        var swatch = element("span", "swatch");
        swatch.style.backgroundColor = colors.main;
        row.appendChild(swatch);
        row.appendChild(element("span", "app-name", item.app));
        row.appendChild(element("span", "number", duration(item.duration_ms)));
        row.appendChild(element("span", "number", percentage(item.ratio)));
        list.appendChild(row);
        return;
      }
      var details = element("details");
      var summary = element("summary");
      summary.appendChild(element("span", "chevron"));
      var detailSwatch = element("span", "swatch");
      detailSwatch.style.backgroundColor = colors.main;
      summary.appendChild(detailSwatch);
      summary.appendChild(element("span", "app-name", item.app));
      summary.appendChild(element("span", "number", duration(item.duration_ms)));
      summary.appendChild(element("span", "number", percentage(item.ratio)));
      details.appendChild(summary);
      var detailList = element("div", "detail-list");
      item.details.forEach(function (detail) {
        var row = element("div", "detail-row");
        var title = element("span", "detail-title", detail.title || "(无标题)");
        title.title = detail.title || "(无标题)";
        row.appendChild(title);
        row.appendChild(element(
          "span",
          "number",
          clock(detail.start_ts, data.timezone) + "–" + clock(detail.end_ts, data.timezone)
        ));
        row.appendChild(element("span", "number", duration(detail.duration_ms)));
        detailList.appendChild(row);
      });
      details.appendChild(detailList);
      list.appendChild(details);
    });
    wrapper.appendChild(list);
    return wrapper;
  }

  function renderDayBody(body, data) {
    body.textContent = "";
    if (data.warning) body.appendChild(element("p", "day-warning", data.warning));
    var timelineSection = element("section", "day-section");
    timelineSection.appendChild(element("h3", "", "行动轨迹"));
    if (!data.activity_blocks.length) {
      timelineSection.appendChild(element("div", "empty", "当天暂无行为轨迹"));
    } else {
      timelineSection.appendChild(renderTimeRange(data, 0));
      timelineSection.appendChild(renderTimeRange(data, 12));
    }
    body.appendChild(timelineSection);
    var usageSection = element("section", "day-section");
    usageSection.appendChild(element("h3", "", "应用使用占比"));
    usageSection.appendChild(renderUsage(data, "day-usage"));
    body.appendChild(usageSection);
  }

  function loadInto(details, day, body) {
    body.textContent = "";
    body.appendChild(element("div", "day-loading", "正在读取当天记录…"));
    loadDay(day).then(function (data) {
      if (details.open) renderDayBody(body, data);
      else loadedDays.delete(day.date);
    }).catch(function (error) {
      if (!details.open) return;
      body.textContent = "";
      body.appendChild(element("div", "empty", error.message));
    });
  }

  function releaseDay(day, body) {
    body.textContent = "";
    loadedDays.delete(day.date);
  }

  function renderHeader() {
    document.getElementById("date-range").textContent = range.from + " 至 " + range.to;
    document.getElementById("duration").textContent = duration(range.totals.recorded_duration_ms);
    document.getElementById("event-count").textContent = range.totals.event_count;
    document.getElementById("active-days").textContent =
      range.totals.active_day_count + " / " + range.totals.day_count;
    document.getElementById("app-count").textContent = range.totals.application_count;
    var source = document.getElementById("source");
    source.textContent = range.live ? "包含进行中活动" : "数据库快照";
    if (!range.live) source.classList.add("offline");
    if (range.warnings.length) {
      var warning = document.getElementById("warning");
      warning.textContent = range.warnings.join("\n");
      warning.style.display = "block";
      warning.style.whiteSpace = "pre-line";
    }
    document.getElementById("generated-at").textContent =
      "生成时间：" + new Date(range.generated_at * 1000).toLocaleString("zh-CN", {
        timeZone: range.timezone
      });
    document.getElementById("range-usage").replaceWith(renderUsage(range, "range-usage"));
  }

  function createDay(day) {
    var details = element("details", "day");
    var summary = element("summary");
    summary.appendChild(element("span", "chevron"));
    summary.appendChild(element("span", "day-date", day.date));
    summary.appendChild(element(
      "span",
      "day-status",
      day.totals.event_count ? duration(day.totals.recorded_duration_ms) : "无记录"
    ));
    summary.appendChild(element("span", "number optional", day.totals.event_count + " 条"));
    summary.appendChild(element("span", "number optional", day.totals.application_count + " 个应用"));
    details.appendChild(summary);
    var body = element("div", "day-body");
    details.appendChild(body);
    details.addEventListener("toggle", function () {
      if (details.open) loadInto(details, day, body);
      else releaseDay(day, body);
    });
    return details;
  }

  function renderDays() {
    var container = document.getElementById("range-days");
    range.days.forEach(function (day) {
      var details = createDay(day);
      container.appendChild(details);
      if (range.initial_expansion === "all") details.open = true;
    });
    document.getElementById("expand-all").addEventListener("click", function () {
      container.querySelectorAll(".day").forEach(function (details) {
        details.open = true;
      });
    });
    document.getElementById("collapse-all").addEventListener("click", function () {
      container.querySelectorAll(".day").forEach(function (details) {
        details.open = false;
      });
    });
  }

  renderHeader();
  renderDays();
})();
