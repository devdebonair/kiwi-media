import "./globals.css";
import "../src/player.css";
import "../src/engagement.css";
import "../src/modern.css";
import "../src/animated-like-button.css";
import "../src/playlist.css";

export const metadata = {
  title: "Kiwi — your media, connected",
  description: "A self-hosted media library organized around topics, moments, and feeds.",
};

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
