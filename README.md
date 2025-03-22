
# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template



----

# Node.js 및 npm 설치 (Amazon Linux 2023의 기본 패키지 사용)
```
sudo dnf install -y nodejs npm

node -v  # Node.js 버전 확인
npm -v   # npm 버전 확인

sudo npm install -g aws-cdk

```

## CDK 프로젝트 생성

```
mkdir core-bank-cdk && cd core-bank-cdk
# CDK 초기화 (TypeScript 기반)
cdk init app --language typescript

```

### git clone
```
git clone
cd core-bank-cdk
npm install

```


### Deploy

```
# cdk bootstrap 
cdk synth

cdk deploy
```

### [참조] DB Credential - username password로 처리
- AWS Secret Manger를 이용해서 하나의 Secret으로 5개의 DB의 Credential을 공유하려고 했으나 CDK 내부적으로 fromSecret()를 호출할 때, RDS 클러스터에 연결하기 위해 SecretTargetAttachment를 자동 생성한다. 그런데 하나의 Secret은 단 하나의 RDS 클러스터에만 attach될 수 있기 때문에 동일한 Secret을 여러 RDS 클러스터의 Credential로 지정하면 CDK가 충돌을 일으킨다.
- [참조] CDK 내부 작동 원리 요약
- rds.DatabaseCluster는 rds.Credentials.fromSecret(...)을 받을 경우 Secret.attach(...)를 자동 호출합니다.
- 한 Secret은 하나의 SecretTargetAttachment만 생성할 수 있습니다. CDK는 중복 Attach에 대해 명시적 예외를 던집니다
- CloudFormation 레벨에서는 여러 DB에 같은 Secret을 수동으로 설정할 수 있지만, CDK는 추상화의 일관성을 유지하려고 막고 있습니다.
