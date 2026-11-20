'use client'

import { useAccount, useChainId } from 'wagmi'
import { config, getL1Chain, getL2Chain } from '@/lib/config'

// Shown only when the wallet is on a network this bridge does not use.
export function NetworkStatus() {
  const { isConnected } = useAccount()
  const chainId = useChainId()

  if (!isConnected || chainId === config.l1ChainId || chainId === config.l2ChainId) return null

  return (
    <span className="text-sm text-warn">
      Wrong network: switch to {getL1Chain().name} or {getL2Chain().name}
    </span>
  )
}
