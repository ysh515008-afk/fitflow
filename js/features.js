/* ============================================================
   features.js · 可选配功能
   ------------------------------------------------------------
   有些模块不是每个门店都用得上。硬塞进导航会让界面看起来比实际复杂，
   而且空白的一栏会让人以为"系统没配好"。所以把它们做成可选配：
   默认不出现，在「功能库」里自己添加。

   判断一个模块该内置还是可选配，只问一个问题：
     **去掉它，核心闭环（内容带线索 → 接线索 → 跟会员 → 成交）会不会断？**
   会断的一律内置且不可移除；不会断的一律可选配。

   这份表是唯一事实来源：导航、子分段、空状态文案都从这里读，
   不在视图里各写一份开关判断，避免"某处忘了判断"导致隐藏的模块又冒出来。
   ============================================================ */

/** 功能分组。组只是展示用的归类，不影响判定逻辑。 */
export const FEATURE_GROUPS = [
  {
    id: 'ops',
    label: '运营',
    desc: '获客、内容与交易数据的相关模块',
    items: [
      {
        id: 'ops.community',
        label: '社群管理',
        icon: 'i-users',
        defaultOn: false,
        core: false,
        desc: '群健康度、周内容日历、公域到私域的承接节奏',
        detail: '只有你真的在运营微信群时才用得上。没有群的时候这一栏会一直是空的，反而让人怀疑系统坏了。',
      },
      {
        id: 'ops.store',
        label: '门店热度',
        icon: 'i-flame',
        defaultOn: true,
        core: false,
        desc: '门店定位下的视频、评论区讨论、绿标白标带货',
        detail: '四项里只有关键词召回那一项能走接口，其余靠手工登记。不盯同城热度的话可以关掉。',
      },
      {
        id: 'ops.ledger',
        label: '内容台账',
        icon: 'i-doc',
        defaultOn: true,
        core: false,
        desc: '手工登记的内容表现与线索贡献',
        detail: '和「抖音账号」那栏是两套账：这里记的是你愿意记的，那里是接口返回的全量作品。',
      },
      {
        id: 'ops.xhs',
        label: '小红书',
        icon: 'i-xhs',
        defaultOn: true,
        core: false,
        desc: '小红书号的笔记台账与线索贡献（账号维度目前只能手工登记）',
        detail: '红狐明确没有小红书账号维度接口（粉丝 / 笔记表现取不到），所以账号数字靠手工登记；'
          + '「小红书搜索」与「小红书爆款笔记库」在红狐能力范围内，但端点与字段契约还没登记进项目，接线后这两块会换成自动取数。',
      },
      {
        id: 'ops.biz',
        label: '交易后台',
        icon: 'i-plug',
        defaultOn: false,
        core: false,
        desc: '抖音来客 / 美团经营宝的曝光、开口、下单、核销数据',
        /*
         * 默认收起，不是因为它没用，是因为接入门槛把它挡在了「以后再说」这一档：
         * 来客的开放能力清单里没有流量数据，美团要品牌总部资质 + 业务经理签约。
         * 对一个单店来说，这块短期很难真正接通，摆在导航里反而让人以为没配好。
         *
         * 收起的是位置，不是能力。两个平台的接口协议（端点清单、鉴权字段、
         * 授权入口、解决方案枚举、字段对应关系）和报表导入口径全部留在代码里，
         * 重新添加时原样回来，一条都不少。
         */
        detail: '两个平台的接口协议与报表导入口径完整保留着，收起只是把它从导航藏起来，重新添加就原样回来。'
          + '接口门槛偏高：来客取不到流量数据（只能从后台导），美团需要品牌总部资质与业务经理签约。',
      },
    ],
  },
];

/** 展平成一张表，视图按 id 直接查 */
export const ALL_FEATURES = FEATURE_GROUPS.flatMap((g) =>
  g.items.map((it) => ({ ...it, group: g.label })));

export const featureById = (id) => ALL_FEATURES.find((x) => x.id === id) || null;

/** 核心模块的 id 清单，界面用它显示"不可移除" */
export const CORE_FEATURE_IDS = ALL_FEATURES.filter((f) => f.core).map((f) => f.id);

export function defaultFeatures() {
  return Object.fromEntries(ALL_FEATURES.map((f) => [f.id, f.core ? true : Boolean(f.defaultOn)]));
}

/**
 * 一个模块当前是不是开着。
 * 三种情况分开处理，避免静默地把功能藏起来：
 *   1. 表里没登记 → 放行。新增模块忘了登记时，宁可多显示也不要凭空消失。
 *   2. 核心模块     → 恒开。
 *   3. 可选模块     → 读用户选择；没有记录时回落到 defaultOn。
 */
export function isFeatureOn(features, id) {
  const f = featureById(id);
  if (!f) return true;
  if (f.core) return true;
  const v = features?.[id];
  return v === undefined ? Boolean(f.defaultOn) : Boolean(v);
}

/** 当前开着的可选模块有多少个，功能库用来显示"已添加 3 个" */
export function countOn(features) {
  return ALL_FEATURES.filter((f) => !f.core && isFeatureOn(features, f.id)).length;
}
