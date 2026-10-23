import { Karla } from "next/font/google";
import "./globals.css";
import "../src/player.css";
import "../src/engagement.css";
import "../src/modern.css";
import "../src/animated-like-button.css";
import "../src/playlist.css";
import "../src/add-tag.css";
import "../src/tag-editor.css";
import "../src/hover-preview.css";
import "../src/downloads.css";
import "../src/liked.css";
import "../src/guide.css";
import "../src/catalog.css";
import "../src/streaming.css";
import "../src/clips.css";
import "../src/shell.css";
import "../src/browse.css";

// Self-hosted at build time, exposed as --font-sans for the stylesheets.
const karla = Karla({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata = {
  title: "Kiwi — your media, connected",
  description: "A self-hosted media library organized around topics, moments, and feeds.",
};

export default function RootLayout({ children }) {
  return <html lang="en" className={karla.variable}><body>{children}</body></html>;
}
