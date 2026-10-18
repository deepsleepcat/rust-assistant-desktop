import type { ComponentType } from 'react'
import { DashboardPanel } from '../../features/dashboard/DashboardPanel'
import { CloudBagPanel } from '../../features/community/CloudBagPanel'

// Explicit shared page contract. Required props must fail static type checking;
// do not infer compatibility from runtime function arity or substitute another page.
export const DashboardSurface: ComponentType = DashboardPanel
export const CloudBagSurface: ComponentType = CloudBagPanel
