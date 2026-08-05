# DeepSeek服务端自动研究组件

该组件把一个有界调查问题提交给DeepSeek Responses API的服务端`web_search`，再由宿主独立读取模型实际打开的网页并核对摘录。生产接入层已经把它连接到M5R的用户授权、预算、运行状态和证据报告；它不会自行调用Brave，也不会直接修改译文或批准知识。

## 组件边界

调用顺序固定为：

1. `DeepSeekServerResearchAdapter.research`对单个`ResearchCase`发起一次`POST /responses`；
2. 请求固定使用`deepseek-v4-flash`、`web_search`和最小JSON Object输出；
3. 适配器从响应动作中提取状态为`completed`的`open_page`网址；
4. 模型来源必须同时满足HTTPS、实际打开、非补充级、支持结论且摘录非空，才能成为`resolved-candidate`；
5. `DeepSeekResearchSourceVerifier`通过现有`RestrictedFetchProxy`独立读取每个候选网址；
6. 请求网址和跳转后的最终网址都必须通过宿主的来源策略；
7. 网页正文中的摘录必须精确匹配，或达到配置的短语覆盖阈值；
8. 至少一个来源通过复核才返回`resolved`，否则安全返回`unresolved`。

模型返回的`not_found`会归一化为`not-found`，仅表示没有找到记录，不能作为正面事实。网络发送后结果未知统一标记为`unknown-outcome`且不允许组件自动重试。

## 组合方式

```js
import { RestrictedFetchProxy } from "../src/search/fetch-proxy.mjs";
import { DeepSeekServerResearchAdapter } from "../src/research/deepseek-server-research-adapter.mjs";
import {
  ConfiguredResearchSourcePolicy,
  DeepSeekResearchSourceVerifier,
} from "../src/research/deepseek-research-source-verifier.mjs";
import { DeepSeekServerResearchService } from "../src/research/deepseek-server-research-service.mjs";

const policy = new ConfiguredResearchSourcePolicy({
  rules: [
    { hostname: "example.gov", includeSubdomains: true, tier: "S1" },
    { hostname: "dictionary.example", includeSubdomains: false, tier: "S2" },
  ],
});

const verifier = new DeepSeekResearchSourceVerifier({
  restrictedFetch: configuredRestrictedFetchProxy,
  sourcePolicy: policy,
});

const service = new DeepSeekServerResearchService({
  adapter: new DeepSeekServerResearchAdapter(),
  verifier,
});
```

`ConfiguredResearchSourcePolicy`默认拒绝未配置域名。它不会相信模型自己声明的`sourceClass`，且网页发生跳转后会对最终域名再次判断。调用方必须使用现有的隔离Broker或等价Secret边界注入凭据，不应把Key保存在组件配置、任务载荷、结果或日志中。

## 生产接入

`DeepSeekResearchIntegrationService`只接受已经包含以下授权项的ResearchGrant：

- 能力：`research-model`；
- Provider：`deepseek-server-research`；
- 工具：短期能力令牌中的`submit-report`；
- 预算：Search动作、唯一打开网址、模型Token和美元微单位费用的单次原子预留。

DeepSeek Key由控制面打开仓库外的`0600`文件，再通过fd 3交给`invokeDeepSeekResearchBroker`。Broker只返回严格归一化的Provider结果，不返回Key、完整Provider响应或reasoning。随后宿主复核器读取网页，`DirectResearchFetchSnapshotService`把正文保存为工作区限域、不可变的direct快照；Source、Citation、Claim和Report继续沿用M5R证据等级。schema v23又把知识提案的证据来源显式区分为旧调查Fetch与直接研究Fetch；合格报告可通过同一`ResearchProposalBridge`形成草稿，但仍只有用户能批准并应用为知识事实。

单一S1窄范围的词典、政府或原始来源可以形成C2；单一普通来源通常仍是C1，因此报告为`insufficient`。`not-found`和`unresolved`不创建正面Claim。unknown保守占用原预留并暂停运行，不会自动重试；中断后遗留的reservation只能由控制面显式调用恢复入口标记为unknown。

```js
import { invokeDeepSeekResearchBroker } from "../src/research/deepseek-research-broker-process.mjs";
import { DeepSeekResearchIntegrationService } from "../src/research/deepseek-research-integration-service.mjs";

const integration = new DeepSeekResearchIntegrationService(database, workspaceId, {
  capabilities,
  budgets,
  runs,
  evidence,
  verifier,
  invokeProvider: invokeDeepSeekResearchBroker,
  pricingSnapshot: configuredUsdPricingSnapshot,
});
```

真实定价必须由控制面以版本化美元微单位快照提供；接入层不把实验时期价格或汇率硬编码为永久价格。

## 输出限制

最终结果明确携带：

```json
{
  "permissions": {
    "mayModifyTranslation": false,
    "mayApproveKnowledge": false
  }
}
```

因此，即使结果为`resolved`，后续工作流也只能把它转换为待审证据或知识提案，不能直接改写译文或批准知识。

## 当前未实现

- Brave或其他搜索服务的条件回退；
- `deepseek-v4-pro`自动切换；
- UI、CLI及翻译工作流触发逻辑。

这些能力应在组件稳定后作为独立工作链路设计，不能通过本组件隐式扩张。
