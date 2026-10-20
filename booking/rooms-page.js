async function loadRoomPrices() {
    try {
        const response = await fetch("/api/rooms");
        if (!response.ok) return;
        const data = await response.json();
        if (!Array.isArray(data.rooms)) return;
        for (const element of document.querySelectorAll("[data-room-price]")) {
            const room = data.rooms.find((entry) => entry.name === element.dataset.roomPrice);
            if (!room) continue;
            const perNight = document.createElement("span");
            perNight.textContent = "per night";
            element.replaceChildren(`KSh ${Number(room.nightlyRate).toLocaleString("en-US")} `, perNight);
        }
    } catch {
        // Keep the static prices when the server is not reachable.
    }
}

loadRoomPrices();
