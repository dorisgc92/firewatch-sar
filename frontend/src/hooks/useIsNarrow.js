import { useState, useEffect } from "react"

/**
 * True when the viewport is narrower than `breakpoint` (default 900px —
 * roughly where the map + always-open 270px sidebar + always-open ~215px
 * layers panel stop having room to coexist). Used to switch the sidebar
 * and layers panel from "always visible, taking real layout space" to
 * "collapsed by default, opens as an overlay" so the map stays usable on
 * tablets/narrow windows instead of getting squeezed to a sliver between
 * two panels.
 */
export default function useIsNarrow(breakpoint = 900) {
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < breakpoint)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [breakpoint])
  return isNarrow
}
