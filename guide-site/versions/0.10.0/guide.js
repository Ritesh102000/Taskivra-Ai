(() => {
  "use strict";

  const content = document.getElementById("guide-content");
  const nav = document.getElementById("guide-nav");
  const search = document.getElementById("guide-search");
  const input = document.getElementById("guide-query");
  const status = document.getElementById("search-status");
  const empty = document.getElementById("search-empty");
  const reset = document.getElementById("search-reset");
  const toggle = document.getElementById("contents-toggle");
  if (!content || !nav || !search || !input || !status || !empty || !reset || !toggle) return;

  const sections = [...content.querySelectorAll("section[id]")];
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const sectionById = new Map(sections.map(section => [section.id, section]));
  const hashId = value => {
    try { return decodeURIComponent(value.replace(/^#/, "")); }
    catch { return ""; }
  };
  const normalize = value => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const searchable = new Map(sections.map(section => [section.id, normalize(section.textContent || "")]));
  const media = window.matchMedia("(max-width: 860px)");
  let matches = sections;
  let queued;

  function setContents(open) {
    toggle.setAttribute("aria-expanded", String(open));
    nav.hidden = media.matches && !open;
  }

  function syncContents() {
    setContents(!media.matches);
  }

  function setCurrent(id) {
    for (const link of links) {
      if (link.hash === `#${id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }

  function filter() {
    const terms = normalize(input.value).split(" ").filter(Boolean);
    matches = sections.filter(section => terms.every(term => searchable.get(section.id).includes(term)));
    const visible = new Set(matches.map(section => section.id));
    for (const section of sections) section.hidden = !visible.has(section.id);
    for (const link of links) {
      const id = hashId(link.hash);
      const item = link.closest("li") || link;
      item.hidden = sectionById.has(id) && !visible.has(id);
    }
    empty.hidden = matches.length !== 0;
    status.textContent = terms.length ? `${matches.length} ${matches.length === 1 ? "chapter" : "chapters"} found. Clear the search to read everything.` : "";
    if (terms.length && matches.length) setCurrent(matches[0].id);
  }

  function clearFilter() {
    clearTimeout(queued);
    input.value = "";
    filter();
  }

  function jumpTo(target, fromContents = false) {
    const heading = target.matches("h2, h3, h4") ? target : target.querySelector("h2, h3") || target;
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "start", behavior: fromContents && !reduceMotion ? "smooth" : "auto" });
    if (location.hash !== `#${target.id}`) {
      history[fromContents ? "pushState" : "replaceState"](null, "", `#${target.id}`);
    }
    const section = target.matches("section") ? target : target.closest("section");
    if (section && sectionById.has(section.id)) setCurrent(section.id);
  }

  search.hidden = false;
  toggle.hidden = false;
  syncContents();
  if (typeof media.addEventListener === "function") media.addEventListener("change", syncContents);
  else media.addListener(syncContents);

  toggle.addEventListener("click", () => setContents(toggle.getAttribute("aria-expanded") !== "true"));
  input.addEventListener("input", () => {
    clearTimeout(queued);
    queued = setTimeout(filter, 120);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" && input.value) {
      clearFilter();
      event.preventDefault();
    }
  });
  search.addEventListener("submit", event => {
    event.preventDefault();
    clearTimeout(queued);
    filter();
    if (matches.length) jumpTo(matches[0]);
  });
  reset.addEventListener("click", () => {
    clearFilter();
    input.focus();
  });

  const navigationLinks = [...links, ...content.querySelectorAll('a[href^="#"]')];
  for (const link of navigationLinks) {
    link.addEventListener("click", event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = document.getElementById(hashId(link.hash));
      if (!target || (target !== nav && !content.contains(target))) return;
      event.preventDefault();
      clearFilter();
      if (target === nav) setContents(true);
      else if (media.matches) setContents(false);
      jumpTo(target, true);
    });
  }
  window.addEventListener("hashchange", () => {
    const target = document.getElementById(hashId(location.hash));
    if (target && (target === nav || content.contains(target))) {
      clearFilter();
      if (target === nav) setContents(true);
      jumpTo(target);
    }
  });
  window.addEventListener("beforeprint", clearFilter);

  const initialTarget = document.getElementById(hashId(location.hash));
  if (initialTarget === nav) setContents(true);
  const initial = initialTarget?.closest("section") || sections[0];
  if (initial) setCurrent(initial.id);
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(entries => {
      const inView = entries.filter(entry => entry.isIntersecting && !entry.target.hidden);
      if (inView.length) {
        inView.sort((first, second) => first.boundingClientRect.top - second.boundingClientRect.top);
        setCurrent(inView[0].target.id);
      }
    }, { rootMargin: "-100px 0px -62% 0px", threshold: 0 });
    sections.forEach(section => observer.observe(section));
  }
})();
