const navToggle = document.querySelector(".nav-toggle");
const navMenu = document.querySelector("#nav-menu");

if (navToggle && navMenu) {
    const setOpen = (open) => {
        navToggle.setAttribute("aria-expanded", String(open));
        navMenu.classList.toggle("is-open", open);
    };

    navToggle.addEventListener("click", () => {
        setOpen(navToggle.getAttribute("aria-expanded") !== "true");
    });

    navMenu.addEventListener("click", (event) => {
        if (event.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setOpen(false);
    });

    window.addEventListener("resize", () => {
        if (window.innerWidth > 760) setOpen(false);
    });
}
