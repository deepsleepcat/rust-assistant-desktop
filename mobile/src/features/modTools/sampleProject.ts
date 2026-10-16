/**
 * 内置示例项目：离线可用的最小模组骨架。
 *
 * 生成 mod-info.txt + units/sampleTank.ini + 单位图片占位资源；
 * 目录重名时由 uniqueProjectDir 自动加序号，**绝不覆盖**已有项目；
 * 中途失败会清理半成品目录（否则 uniqueProjectDir 只会跳过它，留下一串废目录）。
 *
 * 占位图直接内嵌 PNG 字节，不用 canvas 现场编码：真机 WebView 上 `canvas.toBlob`
 * 的可用性没有保证，一旦不可用，创建示例项目就会每次都失败。
 */
import { deleteProject, getBridge, uniqueProjectDir, writeProjectBinary } from '../../services/bridge'
import { minimalModInfoText } from './modInfo'

export const SAMPLE_UNIT_NAME = 'sampleTank'

/** 32×32 纯色带边框 PNG（本体） */
const PLACEHOLDER_BODY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOUlEQVR4nO3OoREAIBAEsS8MgaQ2DJZuYajiEBG7OtX6OMnqba4dCQAAAAAAAAAAAAAAAADgH0CyC1jiTcs8FkZfAAAAAElFTkSuQmCC'

/** 32×32 纯色带边框 PNG（残骸，颜色更深） */
const PLACEHOLDER_DEAD_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR4nO3OIREAIBQFwR+HQdEDgaR/EhhSPMSKO73V+jjJ6m2uHQkAAAAAAAAAAAAAAAAA4B9AsgvCtYqmykdHxAAAAABJRU5ErkJggg=='

/** base64 → 字节（atob 在 WebView 与 jsdom 都可用） */
function decodeBase64(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 示例单位（轻型坦克）：字段覆盖 core / graphics / attack / movement / turret / projectile */
export const SAMPLE_UNIT_TEXT = `# 示例单位：轻型坦克（由铁锈工坊创建）
[core]
name: ${SAMPLE_UNIT_NAME}
displayLocaleKey: 示例坦克
class: CustomUnitMetadata
price: 400
maxHp: 600
mass: 800
techLevel: 1
buildSpeed: 20s
radius: 14
isBio: false
builtFrom_1_name: landFactory

[graphics]
total_frames: 1
image: ${SAMPLE_UNIT_NAME}.png
image_wreak: ${SAMPLE_UNIT_NAME}_dead.png
image_shadow: AUTO
shadowOffsetX: 1
shadowOffsetY: 1

[attack]
canAttack: true
canAttackFlyingUnits: true
turretSize: 10
turretTurnSpeed: 1.5
maxAttackRange: 180
shootDelay: 18

[movement]
movementType: LAND
moveSpeed: 0.9
moveAccelerationSpeed: 0.02
moveDecelerationSpeed: 0.02
maxTurnSpeed: 1.0

[turret_1]
x: 0
y: 0
idleDir: 0
projectile: 1

[projectile_1]
life: 30
speed: 3
directDamage: 25
explodeEffect: NONE
`

export interface SampleProjectResult {
  rootPath: string
  name: string
}

/** 创建一个全新的示例项目（重复创建会得到「示例项目2」这样的新目录） */
export async function createSampleProject(): Promise<SampleProjectResult> {
  const bridge = getBridge()
  const root = await uniqueProjectDir('示例项目')
  try {
    await bridge.project.createFolder(root, root, '')
    await bridge.project.createFolder(root, root, 'units')
    await bridge.project.writeFile(root, `${root}/mod-info.txt`, minimalModInfoText('示例模组'), { hasBom: false })
    await bridge.project.writeFile(root, `${root}/units/${SAMPLE_UNIT_NAME}.ini`, SAMPLE_UNIT_TEXT, { hasBom: false })
    // 单位引用的图片：给出可显示的占位资源，避免示例一打开就缺图
    await writeProjectBinary(root, `${root}/units/${SAMPLE_UNIT_NAME}.png`, decodeBase64(PLACEHOLDER_BODY_PNG))
    await writeProjectBinary(root, `${root}/units/${SAMPLE_UNIT_NAME}_dead.png`, decodeBase64(PLACEHOLDER_DEAD_PNG))
    return { rootPath: root, name: root.split('/').pop() ?? '示例项目' }
  } catch (err) {
    // 失败不能留下打不开的半个项目
    await deleteProject(root).catch(() => {})
    throw err
  }
}
