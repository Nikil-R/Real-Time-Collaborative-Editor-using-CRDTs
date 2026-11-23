"""Starter files for a new workspace. Shown to the first person who opens each file."""

STARTER_FILES: list[tuple[str, str]] = [
    (
        "README.md",
        """# Welcome to your workspace

Everyone with this link edits the **same files at the same time**.

- Open this page in a second window (or send the link) and type: you will see
  each other's cursors, names and changes live.
- Switch to **Offline** in the status bar, keep typing, then go back online.
  Nothing is lost and both versions merge.
- Open the **Debug** panel to see how every character has a permanent id.

Try editing `src/app.ts` in one window and `src/stats.py` in another.
""",
    ),
    (
        "src/app.ts",
        """// A tiny TypeScript example. Edit me from two windows at once.
interface User {
  id: number;
  name: string;
}

const users: User[] = [
  { id: 1, name: "Priya" },
  { id: 2, name: "Rahul" },
];

export function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

users.forEach((u) => console.log(greet(u)));
""",
    ),
    (
        "src/stats.py",
        """# A tiny Python example. Edit me from two windows at once.
from collections import Counter


def top_words(text: str, n: int = 3) -> list[tuple[str, int]]:
    words = [w.strip(".,!?").lower() for w in text.split()]
    return Counter(words).most_common(n)


if __name__ == "__main__":
    print(top_words("the quick brown fox jumps over the lazy dog the end"))
""",
    ),
    (
        "config.json",
        """{
  "name": "demo-project",
  "version": "1.0.0",
  "features": ["live-cursors", "offline-editing", "crdt"]
}
""",
    ),
    (
        "styles.css",
        """:root {
  --accent: #7c5cff;
}

.button {
  background: var(--accent);
  color: white;
  border-radius: 8px;
  padding: 8px 14px;
}
""",
    ),
]
