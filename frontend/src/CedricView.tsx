import { Cedric } from "./Cedric";

export function CedricView() {
  return (
    <section className="cedric-page">
      <div className="cedric-page-panel">
        <div className="cedric-page-copy">
          <h2>Cedric</h2>
          <p>Just Cedric, blinking and glancing around.</p>
        </div>
        <div className="cedric-page-art" aria-label="Cedric the owl">
          <Cedric progress={0} initiallyVisible canHide={false} />
        </div>
      </div>
    </section>
  );
}
