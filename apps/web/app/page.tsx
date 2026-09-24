export default function HomePage() {
  return <main className="page-width" style={{ paddingTop: 70 }}>
    <h1 className="page-title">Find a work. Follow its meaning.</h1>
    <p className="muted" style={{ fontSize: 21, maxWidth: 740, lineHeight: 1.5 }}>
      Search published works and view each result in its selected context.
    </p>
    <p><a className="link-action" href="/search">Explore works →</a></p>
  </main>;
}
