import { FutardHeader } from "@/components/futard-header";

export default function Loading() {
  return (
    <main className="futardLanding">
      <FutardHeader />
      <section className="pageSkeletonShell" aria-label="Loading">
        <div className="pageSkeletonHeader">
          <span className="skeletonBlock skeletonTitle" />
          <span className="skeletonBlock skeletonLine wide" />
          <span className="skeletonBlock skeletonLine medium" />
        </div>
        <div className="launchGrid">
          {Array.from({ length: 6 }).map((_, index) => (
            <article className="launchCard skeletonCard" key={index}>
              <div className="cardTopLine">
                <span className="skeletonBlock launchAvatar" />
                <span className="skeletonBlock skeletonPill" />
                <span className="skeletonBlock skeletonPill small" />
              </div>
              <div className="skeletonStack">
                <span className="skeletonBlock skeletonTitle" />
                <span className="skeletonBlock skeletonLine wide" />
                <span className="skeletonBlock skeletonLine medium" />
              </div>
              <span className="skeletonBlock skeletonProgress" />
              <span className="skeletonBlock skeletonButton" />
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
