// Default chat data with dynamic timestamps relative to current time
// Each old article becomes a chat, each section title + paragraphs become messages

function msg(id, content, timestamp) {
  return { id, content, timestamp }
}

const HOUR = 3600000
const DAY = 86400000

export function getDefaultChats() {
  const NOW = Date.now()

  return [
    {
      id: 'korean-girl-groups',
      title: '韩国女团发展史',
      createdAt: NOW - DAY * 7,
      updatedAt: NOW - DAY * 7 + HOUR * 6,
      tags: ['K-Pop', '女团', '偶像文化'],
      pinned: false,
      messages: [
        msg('kg-1', '## 一代女团：偶像文化的萌芽\n\n韩国女团的历史可以追溯到 1990 年代末。当时，SM 娱乐的李秀满社长在美国留学期间接触到了 MTV，看到了音乐与视觉结合的巨大潜力。回国后，他提出了"文化技术"（Culture Technology）的概念，开始了偶像团体的系统化培养计划。', NOW - DAY * 7),
        msg('kg-2', '1997 年，H.O.T. 作为韩国首个偶像男团出道，获得了巨大成功。这证明了偶像团体模式的可行性，也为女团的发展奠定了基础。两年后，1998 年，S.E.S 作为韩国首个偶像女团正式出道，开启了韩国女团的时代。', NOW - DAY * 7 + HOUR),
        msg('kg-3', 'S.E.S 由 Bada、Eugene 和 Shoo 三名成员组成，她们不仅拥有出色的唱跳实力，还有着鲜明的个人特色。她们的歌曲《I\'m Your Girl》和《Dreams Come True》成为了那个时代的经典。S.E.S 的成功证明了女团同样可以拥有强大的市场号召力。', NOW - DAY * 7 + HOUR * 2),
        msg('kg-4', '## 二代女团：K-Pop 的黄金时代\n\n2000 年代中期，韩国女团迎来了真正的黄金时代。这一时期的代表团体包括少女时代、Wonder Girls、KARA、2NE1 等，她们将 K-Pop 推向了国际舞台。', NOW - DAY * 7 + HOUR * 3),
        msg('kg-5', '2007 年出道的少女时代可以说是韩国女团历史上最成功的团体之一。她们的歌曲《Gee》《Genie》《Oh!》等不仅在韩国本土大获成功，在亚洲各地也拥有庞大的粉丝群体。少女时代的成功不仅体现在音乐销量上，更体现在她们对整个娱乐产业的影响力。', NOW - DAY * 7 + HOUR * 3 + 600000),
        msg('kg-6', 'Wonder Girls 则凭借《Nobody》这首歌曲在全球范围内获得了关注，成为了首个登上美国 Billboard Hot 100 榜单的韩国团体。虽然她们最终没有在美国市场取得长期成功，但她们为后来的 K-Pop 艺人进军国际市场铺平了道路。', NOW - DAY * 7 + HOUR * 3 + 1200000),
        msg('kg-7', '2NE1 以其独特的风格和强烈的个性在众多女团中脱颖而出。她们的音乐风格偏向嘻哈和电子舞曲，打破了传统女团甜美可爱的形象。虽然她们已经解散，但她们对 K-Pop 风格的多元化发展产生了深远影响。', NOW - DAY * 7 + HOUR * 3 + 1800000),
        msg('kg-8', '## 三代女团：风格多元化的时代\n\n2010 年代中期，韩国女团进入了风格多元化的时代。这一时期的代表团体包括 TWICE、BLACKPINK、Red Velvet、MAMAMOO、GFRIEND 等，她们各自都有着独特的风格和定位。', NOW - DAY * 7 + HOUR * 4),
        msg('kg-9', 'TWICE 以其多变的风格和可爱的形象迅速崛起，成为新一代的国民女团。她们的歌曲《Cheer Up》《TT》《Likey》等都有着极高的传唱度。TWICE 的成功证明了多国籍成员模式的有效性，她们的成员来自韩国、日本和台湾。', NOW - DAY * 7 + HOUR * 4 + 600000),
        msg('kg-10', 'BLACKPINK 则以其强大的实力和时尚感成为了国际巨星。她们的音乐风格偏向嘻哈和电子舞曲，MV 制作精良，时尚感十足。BLACKPINK 在国际市场上取得了巨大成功，成为了首个登上 Coachella 音乐节主舞台的 K-Pop 女团。', NOW - DAY * 7 + HOUR * 4 + 1200000),
        msg('kg-11', 'Red Velvet 以其概念性强的音乐和多样化的风格著称。她们的歌曲既有甜美可爱的《Ice Cream Cake》，也有充满力量感的《Psycho》，展现了她们在音乐风格上的无限可能性。', NOW - DAY * 7 + HOUR * 4 + 1800000),
        msg('kg-12', '## 四代女团：新时代的开启\n\n2018 年以后，韩国女团进入了四代时代。这一时期的代表团体包括 (G)I-DLE、ITZY、aespa、IVE、NewJeans、LE SSERAFIM 等，她们在音乐风格、概念表达和互动方式上都有着创新。', NOW - DAY * 7 + HOUR * 5),
        msg('kg-13', '(G)I-DLE 以其自作曲能力和独特的概念著称。她们的歌曲《LATATA》《HWAA》《Tomboy》都取得了巨大成功，展现了她们在音乐创作上的才华。成员田小娟作为制作人，为团体创作了许多热门歌曲。', NOW - DAY * 7 + HOUR * 5 + 600000),
        msg('kg-14', 'aespa 则以其科幻概念和虚拟成员开创了新的互动方式。她们的 MV 融合了大量的 CGI 技术，虚拟成员 ae 与真人成员的互动为 K-Pop 带来了全新的体验。这种"元宇宙"概念在疫情时代得到了更多关注。', NOW - DAY * 7 + HOUR * 5 + 1200000),
        msg('kg-15', 'NewJeans 以其复古风格和自然亲和的形象获得了大量好评。她们的音乐风格偏向 Y2K 风格，给人一种舒适自然的感觉。这种与以往女团截然不同的风格，展现了 K-Pop 的多样化发展。', NOW - DAY * 7 + HOUR * 5 + 1800000),
        msg('kg-16', '## 女团文化的社会影响\n\n韩国女团不仅仅是娱乐产业的一部分，她们对社会文化也产生了深远影响。她们的音乐、时尚、妆容、行为举止都成为了年轻一代模仿的对象。', NOW - DAY * 7 + HOUR * 6),
        msg('kg-17', '女团成员经常成为时尚品牌的代言人，她们的穿搭风格影响着潮流趋势。BLACKPINK 的 Lisa 就成为了多个奢侈品牌的代言人，她的时尚影响力不容小觑。', NOW - DAY * 7 + HOUR * 6 + 300000),
        msg('kg-18', '女团也推动了韩国文化的传播。通过 K-Pop，全世界开始关注韩国文化，学习韩语，了解韩国社会。这种"韩流"现象已经成为韩国软实力的重要组成部分。', NOW - DAY * 7 + HOUR * 6 + 600000),
      ]
    },
    {
      id: 'korean-drama',
      title: '经典韩剧回顾',
      createdAt: NOW - DAY * 12,
      updatedAt: NOW - DAY * 12 + HOUR * 8,
      tags: ['韩剧', '影视', '娱乐'],
      pinned: false,
      messages: [
        msg('kd-1', '## 韩剧的发展历程\n\n韩剧（韩国电视剧）的历史可以追溯到 1960 年代，但真正走向国际舞台是在 1990 年代末。1997 年，韩剧《爱情是什么》在中国播出，开启了韩剧在中国市场的黄金时代。', NOW - DAY * 12),
        msg('kd-2', '2000 年代初期，韩剧迎来了第一个高峰。《冬日恋歌》《蓝色生死恋》《大长今》等剧集在亚洲各地获得了巨大成功，"韩流"现象正式形成。这些剧集以其精美的制作感人的故事和出色的演员表演征服了观众。', NOW - DAY * 12 + HOUR),
        msg('kd-3', '《冬日恋歌》让裴勇俊成为了亚洲巨星，他在日本的影响力甚至被称为"勇殿下"。这部剧的成功不仅体现在收视率上，更体现在它对韩国旅游业的推动——剧中拍摄地春川成为了热门旅游目的地。', NOW - DAY * 12 + HOUR * 2),
        msg('kd-4', '## 经典爱情剧\n\n爱情剧一直是韩剧的主流类型。《来自星星的你》可以说是近年来最成功的爱情剧之一。都敏俊和千颂伊的爱情故事跨越了四百年，融合了科幻、爱情、喜剧等多种元素，创造了收视神话。', NOW - DAY * 12 + HOUR * 3),
        msg('kd-5', '《太阳的后裔》则开创了韩剧的新模式。这部剧采用了"先拍后播"的方式，在亚洲多个国家同步播出，取得了巨大成功。柳时镇和姜暮烟的爱情故事在战场和医院两个场景中展开，展现了不同的爱情侧面。', NOW - DAY * 12 + HOUR * 3 + 600000),
        msg('kd-6', '《鬼怪》以其独特的奇幻设定和深刻的哲学思考赢得了观众的喜爱。鬼怪和阴间使者的前世今生，以及他们与人类的情感纠葛，为观众呈现了一个跨越九百年的爱情故事。', NOW - DAY * 12 + HOUR * 3 + 1200000),
        msg('kd-7', '## 悬疑与犯罪剧\n\n韩剧在悬疑和犯罪题材方面也有出色表现。《信号》以其创新的时空穿越设定和紧张刺激的剧情赢得了观众的喜爱。现代刑警朴海英通过一部旧对讲机与过去的刑警李材韩通话，共同破获了多起悬案。', NOW - DAY * 12 + HOUR * 5),
        msg('kd-8', '《秘密森林》以反腐为背景，展现了检察官黄始木的正义之路。剧中没有煽情的爱情线，只有严谨的逻辑和深刻的人性思考。曹承佑的精湛演技让这个角色深入人心。', NOW - DAY * 12 + HOUR * 5 + 600000),
        msg('kd-9', '《王国》以朝鲜王朝为背景，融合了丧尸元素和历史剧的质感。剧中的政治斗争、人性的丑陋和生存的挣扎都表现得淋漓尽致。这部剧的国际化制作水准也为韩剧开拓了新的市场。', NOW - DAY * 12 + HOUR * 5 + 1200000),
        msg('kd-10', '## 韩剧的国际影响力\n\n近年来，韩剧的国际影响力不断提升。2021 年，《鱿鱼游戏》在全球 Netflix 平台上获得了巨大成功，成为了首个在 90 多个国家登上榜首的非英语剧集。这部剧的成功标志着韩剧已经进入了全球主流市场。', NOW - DAY * 12 + HOUR * 7),
        msg('kd-11', '《黑暗荣耀》讲述了一个关于复仇的故事，宋慧乔饰演的文东恩在经历了校园暴力后，用十年的时间策划复仇。这部剧的剧情紧凑、节奏明快，展现了韩剧在类型化方面的成熟。', NOW - DAY * 12 + HOUR * 7 + 600000),
        msg('kd-12', '韩剧的成功也带动了韩国文化的传播。通过韩剧，全世界开始了解韩国的历史、文化、社会和生活。韩剧中的美食、时尚、音乐都成为了韩国文化输出的重要载体。', NOW - DAY * 12 + HOUR * 8),
      ]
    },
    {
      id: 'haskell-intro',
      title: 'Haskell 编程语言入门',
      createdAt: NOW - DAY * 2,
      updatedAt: NOW - DAY * 2 + HOUR * 7,
      tags: ['Haskell', '函数式编程', '编程语言'],
      pinned: true,
      messages: [
        msg('hs-1', '## 什么是 Haskell？\n\nHaskell 是一种纯函数式编程语言，以其强大的类型系统和优雅的语法而闻名。它以逻辑学家 Haskell Curry 的名字命名，最初于 1990 年发布，至今仍在不断发展和改进。', NOW - DAY * 2),
        msg('hs-2', 'Haskell 与传统的命令式编程语言（如 C、Java、Python）有着根本性的不同。它不使用可变状态和循环，而是通过函数组合和递归来实现计算。这种编程范式虽然初学者可能不习惯，但一旦掌握，就能写出更加简洁、可维护的代码。', NOW - DAY * 2 + HOUR),
        msg('hs-3', 'Haskell 的设计哲学是"让函数做数学函数该做的事"。在数学中，函数是纯的，即相同的输入总是产生相同的输出，不会有副作用。Haskell 将这一概念应用到了编程中，使得代码更加可预测和可测试。', NOW - DAY * 2 + HOUR + 300000),
        msg('hs-4', '## 纯函数式编程的特点\n\n纯函数式编程的核心是"纯函数"。纯函数是指没有副作用的函数，它只依赖于输入参数，不依赖于外部状态，也不会修改外部状态。这使得纯函数具有引用透明性，即可以用函数调用的结果替换函数调用本身，而不会影响程序的行为。', NOW - DAY * 2 + HOUR * 2),
        msg('hs-5', '在 Haskell 中，由于没有可变状态，传统的循环（如 for、while）被递归和高阶函数（如 map、filter、fold）所取代。例如：\n\n```haskell\n-- 用递归计算列表的和\nlistSum :: [Int] -> Int\nlistSum []     = 0\nlistSum (x:xs) = x + listSum xs\n\n-- 用 fold 实现同样的功能\nlistSum\' :: [Int] -> Int\nlistSum\' = foldl (+) 0\n```', NOW - DAY * 2 + HOUR * 2 + 600000),
        msg('hs-6', 'Haskell 的另一个重要特性是惰性求值（Lazy Evaluation）。这意味着表达式只有在需要时才会被计算。这种特性可以带来性能上的优势，比如可以处理无限的数据结构：\n\n```haskell\n-- 无限的自然数列表\nnats :: [Int]\nnats = [0..]\n\n-- 取前10个\ntake 10 nats  -- [0,1,2,3,4,5,6,7,8,9]\n```', NOW - DAY * 2 + HOUR * 3),
        msg('hs-7', '## Haskell 的类型系统\n\nHaskell 拥有强大的静态类型系统。与其他静态类型语言不同，Haskell 的类型系统支持类型推导，这意味着编译器可以根据上下文自动推断出变量的类型，而不需要程序员显式声明。', NOW - DAY * 2 + HOUR * 4),
        msg('hs-8', 'Haskell 还支持类型类（Type Classes），这是一种类似于接口的概念。类型类定义了一组函数的类型签名，任何实现了这些函数的类型都可以成为该类型类的实例：\n\n```haskell\nclass Describable a where\n  describe :: a -> String\n\ndata Color = Red | Green | Blue\n\ninstance Describable Color where\n  describe Red   = "red"\n  describe Green = "green"\n  describe Blue  = "blue"\n```', NOW - DAY * 2 + HOUR * 4 + 600000),
        msg('hs-9', '## 基本的 Haskell 语法\n\nHaskell 的函数定义非常简洁，支持模式匹配（Pattern Matching）：\n\n```haskell\n-- 阶乘函数\nfactorial :: Integer -> Integer\nfactorial 0 = 1\nfactorial n = n * factorial (n - 1)\n\n-- 斐波那契数列\nfib :: Int -> Int\nfib 0 = 0\nfib 1 = 1\nfib n = fib (n-1) + fib (n-2)\n```', NOW - DAY * 2 + HOUR * 5),
        msg('hs-10', '列表是 Haskell 中最常用的数据结构之一。Haskell 提供了丰富的列表操作函数：\n\n```haskell\n-- 列表推导\nevens = [x | x <- [1..20], even x]\n-- [2,4,6,8,10,12,14,16,18,20]\n\n-- map 和 filter\ndoubled = map (*2) [1..5]    -- [2,4,6,8,10]\nsmall   = filter (<3) [1..5] -- [1,2]\n```', NOW - DAY * 2 + HOUR * 5 + 600000),
        msg('hs-11', '## 学习 Haskell 的挑战与收获\n\n学习 Haskell 对习惯了命令式编程的程序员来说确实是一个挑战。你需要改变思维方式，学会用函数组合和递归来思考问题。理解 Monad、Functor 等抽象概念需要时间和实践。', NOW - DAY * 2 + HOUR * 6),
        msg('hs-12', '学习 Haskell 的收获是巨大的。它不仅教会你一种新的编程语言，更重要的是教会你一种新的思维方式。这种思维方式可以帮助你在使用其他编程语言时写出更好的代码。\n\n推荐资源：\n- *Learn You a Haskell for Great Good!*\n- *Real World Haskell*\n- [Haskell Wiki](https://wiki.haskell.org)', NOW - DAY * 2 + HOUR * 7),
      ]
    },
    {
      id: 'lambda-calculus',
      title: 'Lambda 演算：计算的本质',
      createdAt: NOW - DAY * 4,
      updatedAt: NOW - DAY * 4 + HOUR * 8,
      tags: ['Lambda 演算', '计算机科学', '理论'],
      pinned: true,
      messages: [
        msg('lc-1', '## Lambda 演算的起源\n\nLambda 演算（Lambda Calculus）是由数学家阿隆佐·邱奇（Alonzo Church）在 1930 年代提出的。这是一种用于研究函数定义、函数应用和递归的形式系统。它的出现早于电子计算机，但最终成为了现代计算机科学的理论基础。', NOW - DAY * 4),
        msg('lc-2', '有趣的是，图灵机（由艾伦·图灵提出）和 Lambda 演算是两种不同的计算模型，但它们在计算能力上是等价的。这意味着任何可以用图灵机计算的问题，也可以用 Lambda 演算来计算，反之亦然。', NOW - DAY * 4 + HOUR),
        msg('lc-3', '## Lambda 演算的基本概念\n\nLambda 演算的语法非常简洁，只有三种基本形式：\n\n1. **变量**（如 $x$）\n2. **抽象**（如 $\\lambda x.M$，其中 $M$ 是一个表达式）\n3. **应用**（如 $M \\ N$，表示将函数 $M$ 应用于参数 $N$）\n\n例如，恒等函数可以表示为 $\\lambda x.x$，自应用函数表示为 $\\lambda x.x \\ x$。', NOW - DAY * 4 + HOUR * 2),
        msg('lc-4', '## Alpha 转换和 Beta 归约\n\n**Alpha 转换**：重命名绑定变量。$\\lambda x.x$ 和 $\\lambda y.y$ 在语义上是等价的。\n\n**Beta 归约**：函数应用的计算规则。\n\n$$(\\lambda x.x + 1) \\ 2 \\rightarrow 2 + 1 \\rightarrow 3$$\n\nBeta 归约是 Lambda 演算中最基本的计算步骤。', NOW - DAY * 4 + HOUR * 3),
        msg('lc-5', '## Church 编码\n\nLambda 演算最初只包含函数的概念，没有数字、布尔值等基本数据类型。但 Church 证明了我们可以用纯函数来表示这些概念：\n\n**Church 数字：**\n$$0 = \\lambda f.\\lambda x.x$$\n$$1 = \\lambda f.\\lambda x.f \\ x$$\n$$2 = \\lambda f.\\lambda x.f \\ (f \\ x)$$\n$$n = \\lambda f.\\lambda x.f^n \\ x$$\n\n**Church 布尔：**\n$$\\text{True} = \\lambda x.\\lambda y.x$$\n$$\\text{False} = \\lambda x.\\lambda y.y$$', NOW - DAY * 4 + HOUR * 4),
        msg('lc-6', '## 递归和 Y 组合子\n\n在 Lambda 演算中，函数是匿名的，无法通过名称来引用自身。那么如何实现递归呢？答案是 **Y 组合子**（Y Combinator）：\n\n$$Y = \\lambda f.(\\lambda x.f \\ (x \\ x)) \\ (\\lambda x.f \\ (x \\ x))$$\n\n对于任何函数 $f$，$Y \\ f = f \\ (Y \\ f)$。用 Y 组合子可以定义递归函数：\n\n$$\\text{factorial} = Y \\ (\\lambda f.\\lambda n.\\text{if} \\ n = 0 \\ \\text{then} \\ 1 \\ \\text{else} \\ n \\times f \\ (n - 1))$$', NOW - DAY * 4 + HOUR * 5),
        msg('lc-7', '## 类型化的 Lambda 演算\n\n简单类型 Lambda 演算为每个表达式分配一个类型。例如 $\\lambda x.x$ 的类型是 $\\alpha \\to \\alpha$。\n\nHindley-Milner 类型系统（用于 ML 和 Haskell）就是基于类型化 Lambda 演算的。理解 Lambda 演算有助于理解现代编程语言的类型系统。', NOW - DAY * 4 + HOUR * 6),
        msg('lc-8', '## Lambda 演算与编程语言\n\n许多编程语言都支持 lambda 表达式或匿名函数：\n\n```python\n# Python\nsquare = lambda x: x * x\n```\n\n```javascript\n// JavaScript\nconst square = x => x * x;\n```\n\n```haskell\n-- Haskell\nsquare = \\x -> x * x\n```\n\nLambda 演算提醒我们，计算不仅仅是关于数字的运算，更是关于函数的组合和变换。', NOW - DAY * 4 + HOUR * 8),
      ]
    },
    {
      id: 'swi-prolog',
      title: 'SWI-Prolog 编程实践',
      createdAt: NOW - HOUR * 6,
      updatedAt: NOW - HOUR * 6 + HOUR * 5,
      tags: ['Prolog', '逻辑编程', '人工智能'],
      pinned: false,
      messages: [
        msg('sp-1', '## Prolog 是什么？\n\nProlog（Programming in Logic）是一种逻辑编程语言，它的设计理念是基于一阶逻辑和回溯搜索。与命令式编程语言不同，Prolog 程序不是描述如何计算结果，而是描述问题的事实和规则，让 Prolog 系统自动推导出结果。', NOW - HOUR * 6),
        msg('sp-2', 'SWI-Prolog 是 Prolog 的一种实现，由 Jan Wielemaker 开发。它是目前最流行、功能最丰富的 Prolog 系统之一，广泛应用于教育、研究和工业领域。', NOW - HOUR * 5),
        msg('sp-3', '## Prolog 的基本概念\n\nProlog 程序由三部分组成：\n\n1. **事实（Facts）**：描述世界的基本信息\n2. **规则（Rules）**：描述如何从已知信息推导出新信息\n3. **查询（Queries）**：向 Prolog 系统提出问题\n\n```prolog\n% 事实\nparent(tom, bob).\nparent(bob, ann).\nmale(tom).\nmale(bob).\nfemale(ann).\n\n% 规则\ngrandparent(X, Y) :- parent(X, Z), parent(Z, Y).\nfather(X, Y) :- parent(X, Y), male(X).\n\n% 查询\n?- grandparent(tom, ann).  % true\n?- father(X, bob).         % X = tom\n```', NOW - HOUR * 4),
        msg('sp-4', '## 回溯与搜索\n\n回溯（Backtracking）是 Prolog 的核心机制。当一个查询有多种可能的答案时，Prolog 会逐一尝试。如果某个答案导致后续查询失败，Prolog 会回溯到上一个选择点，尝试另一个答案。\n\n这种自动搜索机制使得 Prolog 特别适合解决组合问题、约束满足问题和搜索问题。', NOW - HOUR * 3),
        msg('sp-5', '## Prolog 的数据结构\n\nProlog 的列表操作通过模式匹配实现：\n\n```prolog\n% 列表长度\nlist_length([], 0).\nlist_length([_|T], N) :- \n    list_length(T, N1), \n    N is N1 + 1.\n\n% 列表成员\nmember(X, [X|_]).\nmember(X, [_|T]) :- member(X, T).\n\n% 列表追加\nappend([], L, L).\nappend([H|T], L, [H|R]) :- append(T, L, R).\n```\n\n`[H|T]` 可以匹配任何非空列表，其中 `H` 是头元素，`T` 是尾列表。', NOW - HOUR * 2),
        msg('sp-6', '## SWI-Prolog 的特性\n\nSWI-Prolog 提供了丰富的库和工具：内置 HTTP 服务器、JSON 处理、XML 解析等。支持多线程编程、约束逻辑编程（CLP）、模块化编程和单元测试。', NOW - HOUR * 1.5),
        msg('sp-7', '## Prolog 的应用领域\n\nProlog 在人工智能领域有着广泛应用：\n- 自然语言处理\n- 知识表示与推理\n- 专家系统\n- 规划系统\n- 数据库查询\n- 规则引擎', NOW - HOUR * 1.2),
        msg('sp-8', '学习 Prolog 不仅是为了掌握一种编程语言，更是为了学习一种不同的思维方式。这种思维方式将帮助你在面对复杂问题时，能够从逻辑和约束的角度进行思考，找到更加优雅和简洁的解决方案。\n\n推荐资源：\n- *Prolog Programming for Artificial Intelligence*\n- *Learn Prolog Now!*\n- *The Craft of Prolog*', NOW - HOUR),
      ]
    },
    {
      id: 'essay-test',
      title: '页面排版测试',
      createdAt: NOW - HOUR * 3,
      updatedAt: NOW - HOUR * 3 + HOUR * 2,
      tags: ['测试', '排版', '图片'],
      pinned: false,
      messages: [
        msg('es-1', '## Lorem Ipsum Dolor Sit Amet\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.', NOW - HOUR * 3),
        msg('es-2', '![ME](/img/home/ME.png) ![ZS](/img/ZS.png) ![ME_2](/img/home/ME_2.png)', NOW - HOUR * 3 + 600000),
        msg('es-3', 'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Curabitur pretium tincidunt lacus. Nulla gravida orci a odio.', NOW - HOUR * 3 + HOUR),
        msg('es-4', 'Nam liber tempor cum soluta nobis eleifend option congue nihil imperdiet doming id quod mazim placerat facer possim assum. Typi non habent claritatem insitam; est usus legentis in iis qui facit eorum claritatem. Investigationes demonstraverunt lectores legere me lius quod ii legunt saepius.', NOW - HOUR * 3 + HOUR * 1.5),
        msg('es-5', '## 测试标题：此处用于展示页面排版效果\n\n这是一段测试文本，用于验证页面的字体渲染、行高设置以及首行缩进效果。在开发过程中，我们通常使用无实际意义的占位符来代替最终内容，以便专注于视觉设计和布局结构，而不被具体的文字含义所干扰。', NOW - HOUR * 2.5),
        msg('es-6', '第二段测试内容：这里模拟了中等长度的段落。你可以观察到文字在两端的对齐方式，以及段落之间的间距是否符合设计预期。如果使用了自定义字体，这里也是检查生僻字或特殊符号显示是否正常的最佳位置。测试、测试、再测试，确保每一个细节都完美呈现。', NOW - HOUR * 2.5 + 600000),
        msg('es-7', '![ME](/img/home/ME.png) ![ZS](/img/ZS.png) ![ME_2](/img/home/ME_2.png)', NOW - HOUR * 2.5 + HOUR),
        msg('es-8', '第三段测试内容：通常用于展示长文本的溢出处理或滚动条效果。当内容足够多时，右侧的自定义滚动条应当正常显示，并且鼠标悬停时会有颜色变化。此外，背景色与文字颜色的对比度也在此处进行最终确认，以确保用户在不同光线环境下都能舒适地阅读内容。', NOW - HOUR * 2.5 + HOUR * 1.5),
      ]
    }
  ]
}
