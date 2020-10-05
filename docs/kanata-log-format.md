# Kanata Log Format

## Introduction

* Kanata is a log format to record the behavior of processor pipelines.  
    * It records events (fetch, rename, dispatch, etc.) that occur in a processor.
    * This file format is generic one and is basically independent from specific ISA and microarchitecture.
* This format is based on a tab-separated plain text.
    * Each line is tab-separated and it represents a command and its arguments.
* The cycle time in the log file goes in one direction from the beginning to the end.
    * Once a future event has been output, it is not possible to add past events.


## Structure

### Header

The first line of a file stores a header indicating a Kanata format and its version. The current version is 4. For example:

	Kanata	0004
	...


### Log Body

The remaining part after the header is the body of a log, and each line stores a command that represents an operation (e.g., fetch) for a single instruction. The basic format of each line is as follows.

* Each line consists of multiple columns separated by tabs.
* The first column is a command name.
* The subsequent columns are variable parameters and are interpreted according to the command.

For example, 

    commandA	param0	param1	...
    commandB	param0	...


Typically，the first parameter (param0) is the ID of an instruction.


### Instruction ID

Each command uses a unique ID in a file to specify the target of the command. The ID of each instruction is set by the second argument of the "L" command described later.


### Lane

Each instruction can have multiple pipeline states, which can be overlaid in a viewer. For example, you can overlay a stall state on top of the normal pipeline stages.

An overlaid layer is called a "lane", and is specified by the second argument of the "S" or "E" command. By default, the lane zero outputs normal pipelines and the lane one outputs stall.


## Command Reference

## C= 
    
    C=	CYCLE

* Specify the number of cycles since simulation start.
* CYCLE is the number of cycles elapsed from the start of simulation to the start of a log.
* Usually it appears after the header line.


Example: This log output starts from the cycle　7　

    C=	7


## C 
    C	CYCLE

* Specifies the number of elapsed cycles since the last log output.
* CYCLE: the number of elapsed cycles
* All commands that appear until the next C command belong to this time domain.
* Since commands are typically output almost every cycle, "C 1" is very common.

Example: 1 cycle has elapsed. 

    C	1


## I 
* 特定の命令に関するコマンド出力の開始
* 使用例：
```
I	0	0	0
```
* 命令に関するコマンドを出力する前にこれが必要
    * ファイル内に新しい命令が初めて現れた際に出力
* 2列目はファイル内の一意のID
    * ファイル内で現れるたびに振られるシーケンシャルなID
    * 基本的に他のコマンドは全てこのIDを使って命令を指定する
* 3列目は命令のID
    * シミュレータ内で命令に振られているID．任意のIDが使える
* 4列目はTID（スレッド識別子）

## L 
* 命令に任意のラベルをつける
    * 命令が生きている期間は任意のラベルをつけることができる
    * Lが複数回実行された場合，前回までに設定したラベルに追記される

### フォーマット： 
```
L	<ID>	<Type>	<Label Data>
```
1. ID
    * ファイル内の一意のID
1. Type
    * ラベルのタイプ
        * 0: ビジュアライザ左に直接表示されるラベル．通常はPCと命令，レジスタ番号など
        * 1: マウスオーバー時に表示される詳細．実行時のレジスタの値や使用した演算器など
1. Label Data
    * 任意のテキスト

### 使用例： 
```
L	0	0	120047734: r1 = iALU( r16 )
```


## S 

ステージ開始

### フォーマット 
```
S	<ID>	<Lane>	<Stage Name>
```
* 2列目は命令のID
* 3列目はレーンのID
* 4列目はステージ名
    * onikiri2側で新しいステージを勝手に追加しても大丈夫

### 使用例： 
```
S	0	F
```


## E 
ステージ終了

### フォーマット 
```
E	<ID>	<Lane>	<Stage Name>
```
* 2列目は命令のID
* 3列目はレーンのID
* 4列目はステージ名

### 使用例： 
```
E	0	F
```

## R 
特定の命令に関するコマンド出力の終了

### フォーマット 
```
R	<ID>	<Retire ID>	<Type>
```

* フラッシュの場合もリタイアの場合もRを出力する必要がある
* 2列目は命令のID
* 3列目はリタイアID
    * フラッシュされずにリタイアされた命令に対して一意となるID
    * onikiri2はフラッシュされる命令にも投機的にリタイアIDを振るため，リタイアIDは重複する場合がある
* 4列目はリタイア/フラッシュの識別
    * 0ならリタイア
    * 1ならフラッシュ

### 使用例： 
```
R	4	4	0
```

## W 
* 任意の依存関係
    * 典型的にはウェイクアップ
    * タイプ番号の指定により，違う色で表示される

### フォーマット 
```
W	<Consumer ID>	<Producer ID>	<Type>
```
* 2列目はコンシューマーのID
* 3列目はプロデューサーのID
* 4列目は依存関係のタイプ
    * 0ならウェイクアップ
    * 1以降は今のところ予約
* コンシューマーが生きている期間のみ使用可能

### 使用例： 
```
W	1	0	0
```

# 出力例 

	Kanata	0004 // 0004 バージョンのファイル
	C=	216	// 216 サイクル目から開始
	I	0	0	0	// 命令0の開始
	L	0	0	12000d918 r4 = iALU(r3, r2)	// 命令0にラベル付け
	S	0	0	F	// 命令0のFステージを開始
	I	1	1	0	// 命令1の開始
	L	1	0	12000d91c iBC(r17)	// 命令1にラベル付け
	S	1	0	F	// 命令1のFステージを開始
	C	1		// 1サイクル経過
	E	0	0	F	// 命令0のFステージ終了
	S	0	0	Rn	// 命令0のRnステージ開始
	E	1	0	F	// 命令1のFステージ終了
	S	1	0	Rn	// 命令1のFステージ開始

