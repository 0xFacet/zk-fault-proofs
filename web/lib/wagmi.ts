import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { config, getL1Chain } from './config'

// Dynamically determine which L1 chain to include based on config
const l1Chain = getL1Chain()
const chains = [l1Chain] as const

export const wagmiConfig = getDefaultConfig({
  appName: 'Facet ZK Fault Proofs',
  projectId: config.walletConnectProjectId || 'YOUR_PROJECT_ID',
  chains,
  // Reads (balances) go through the configured RPC; viem's default public RPC rate-limits.
  transports: { [l1Chain.id]: http(config.l1RpcUrl) } as Record<(typeof chains)[number]['id'], ReturnType<typeof http>>,
  ssr: true,
})
