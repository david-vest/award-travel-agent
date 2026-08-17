"use client";

import Image from "next/image";
import { useState } from "react";
import styles from "./page.module.css";

export function AirlineLogo({ code, name, size = 36 }: { code: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className={styles.airlineLogoFallback} style={{ width: size, height: size }}>{code}</span>;
  }

  return (
    <span className={styles.airlineLogo} style={{ width: size, height: size }}>
      <Image
        src={`/api/logos/${code}.png`}
        alt={`${name} logo`}
        width={size}
        height={size}
        unoptimized
        onError={() => setFailed(true)}
      />
    </span>
  );
}
