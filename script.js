const navToggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".site-nav");
const year = document.querySelector("#year");

if (year) {
  year.textContent = new Date().getFullYear();
}

if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

// "Demos" dropdown: hover opens it on desktop; tap/click toggles it on touch.
const navDd = document.querySelector(".nav-dd");
const navDdBtn = navDd && navDd.querySelector(".nav-dd-btn");
if (navDd && navDdBtn) {
  navDdBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = navDd.classList.toggle("open");
    navDdBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!navDd.contains(e.target)) {
      navDd.classList.remove("open");
      navDdBtn.setAttribute("aria-expanded", "false");
    }
  });
}

// Scroll-reveal animations (respects reduced-motion)
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealTargets = document.querySelectorAll(
  ".section-heading, .hero-content, .hero-portrait, .about-portrait, .card, .project, .photo-masonry figure, .timeline-item, .publication-list, .contact-card"
);

if (prefersReducedMotion || !("IntersectionObserver" in window)) {
  revealTargets.forEach((el) => el.classList.add("in-view"));
} else {
  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );

  revealTargets.forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${Math.min(i % 3, 2) * 90}ms`;
    observer.observe(el);
  });
}
