# DeepSeek服务端自动研究组件

该组件把一个有界调查问题提交给DeepSeek Responses API的服务端`web_search`，再由宿主独立读取模型实际打开的网页并核对摘录。它是独立能力，不会自行调用Brave，也没有接入翻译任务、知识库或用户批准流程。

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
- 数据库持久化、ResearchGrant接入和预算预留；
- UI、CLI及翻译工作流触发逻辑。

这些能力应在组件稳定后作为独立工作链路设计，不能通过本组件隐式扩张。
