import { FutardHeader } from "@/components/futard-header";
import { LiveTicker } from "@/components/live-ticker";

export default function PresaleLoading() {
  return (
    <main className="futardLanding">
      <FutardHeader />
      <LiveTicker />
      <section className="launchDetailShell" aria-label="Loading launch">
        <div className="presaleSkeletonGrid">
          <div className="presaleSkeletonMain">
            <span className="skeletonBlock skeletonBanner" />
            <div className="launchIdentityRow">
              <span className="skeletonBlock launchDetailAvatar" />
              <div className="skeletonStack">
                <span className="skeletonBlock skeletonTitle" />
                <span className="skeletonBlock skeletonLine wide" />
                <span className="skeletonBlock skeletonLine medium" />
              </div>
            </div>
            <span className="skeletonBlock skeletonProgress" />
            <span className="skeletonBlock skeletonPanel" />
          </div>
          <aside className="presaleSkeletonSide">
            <span className="skeletonBlock skeletonLine medium" />
            <span className="skeletonBlock skeletonPanel" />
            <span className="skeletonBlock skeletonButton" />
          </aside>
        </div>
      </section>
    </main>
  );
}
