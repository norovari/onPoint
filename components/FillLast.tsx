"use client";

// Fills every empty count on this sheet with the last shift's closing count,
// so staff only change what's different. Saved counts are never overwritten.
export function FillLast({ count }: { count: number }) {
  return (
    <button
      type="button"
      className="quiet"
      onClick={(e) => {
        const form = (e.currentTarget as HTMLButtonElement).closest("form");
        let n = 0;
        form?.querySelectorAll<HTMLInputElement>("input[data-last]").forEach((i) => {
          if (i.value === "" && i.dataset.last) { i.value = i.dataset.last; n++; }
        });
        (e.currentTarget as HTMLButtonElement).textContent = n ? `Filled ${n} products from the last close. Check them and change only what is different.` : "Nothing to fill";
      }}
    >
      Use last close’s counts ({count} products)
    </button>
  );
}
