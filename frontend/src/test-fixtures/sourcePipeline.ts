// Synthetic inputs exercised through real Worker, Journal, Pusher and Proxy API. Inert ACK; not production records.
export const sourcePipelineFixtures = {
  "early": {
    "tableId": "BAV03A",
    "trendBundle": {
      "schemaVersion": 1,
      "tableId": "BAV03A",
      "shoe": "1648",
      "completedRound": 1,
      "status": "pending",
      "reason": "coverage-mismatch"
    },
    "displayName": "MT百家樂第4桌",
    "tableType": "BAC",
    "shoe": 1648,
    "round": 3,
    "bankerCount": 0,
    "playerCount": 1,
    "tieCount": 0,
    "bankerPairCount": 0,
    "playerPairCount": 0,
    "beadPlateRaw": "01",
    "bigRoadRaw": "0801",
    "bigEyeRaw": "",
    "smallRoadRaw": "",
    "cockroachRaw": "",
    "nextBankerRaw": {
      "bead_plate": "0102",
      "big": "0801#0702",
      "big_eye": "",
      "small": "",
      "cockroach": ""
    },
    "nextPlayerRaw": {
      "bead_plate": "0101",
      "big": "0801,0701",
      "big_eye": "",
      "small": "",
      "cockroach": ""
    },
    "dealerName": null,
    "totalPlayers": 0,
    "roomId": 51,
    "state": null,
    "orderState": null,
    "sourceUpdatedAt": "2026-10-26T10:50:09.688Z",
    "roundBasis": "visible",
    "buildVersion": "v105",
    "prediction": {
      "source": "backend",
      "buildVersion": "v105",
      "strategyVersion": "v105",
      "targetTableId": "BAV03A",
      "targetShoe": "1648",
      "targetRound": 3,
      "predictedResult": "player",
      "confidence": 47,
      "probabilities": {
        "banker": 0,
        "player": 100,
        "tie": 0
      },
      "scoreTotals": {
        "banker": 0.46405555555539996,
        "player": 0.5359444444446001
      },
      "scoreSources": {
        "roadmap_trend_signals": {
          "banker": 0.5,
          "player": 0.5
        },
        "ask_road_signals": {
          "banker": 0.44,
          "player": 0.56
        },
        "recent_practical_calibration": {
          "banker": 0.5,
          "player": 0.5
        },
        "shoe_banker_player_bias": {
          "banker": 0.444444444444,
          "player": 0.555555555556
        },
        "neutral_reserve": {
          "banker": 0.5,
          "player": 0.5
        }
      },
      "sidePredictions": {
        "tie": 0,
        "superSix": 45.6875,
        "bankerPair": 37.70117647058824,
        "playerPair": 44.5,
        "bankerDragon": 29,
        "playerDragon": 66
      },
      "sideActions": {
        "tie": false,
        "superSix": false,
        "bankerPair": false,
        "playerPair": false,
        "bankerDragon": false,
        "playerDragon": false
      },
      "mainStreakAdjustment": {
        "applied": false,
        "reason": "v105_no_lock_risk",
        "confidencePenalty": 0,
        "finalConfidence": 47,
        "supportGroupCount": 1,
        "supportGroups": {
          "roadmap": false,
          "askRoad": true
        },
        "actionSuppressed": false
      },
      "tableRecentHitRate": null,
      "tableRecentPredictionCount": 0,
      "shortRunAdjustment": {
        "rule": "v105",
        "includedMainWeightCount": 5,
        "includedSideWeightCount": 28,
        "sideActionRateTargets": {
          "tie": 0.15,
          "superSix": 0.1,
          "bankerPair": 0.2,
          "playerPair": 0.2,
          "bankerDragon": 0.08,
          "playerDragon": 0.08
        },
        "sideTargetHitRate": 0.5,
        "baseProbabilities": {
          "banker": 0,
          "player": 100,
          "tie": 0
        }
      },
      "predictionFeatures": {
        "prediction_timing": "pre_result_context",
        "mt_context": {
          "tableId": "BAV03A",
          "displayName": "MT百家樂第4桌",
          "tableType": "BAC",
          "roomId": 51,
          "dealerName": null,
          "totalPlayers": 0,
          "state": null,
          "orderState": null,
          "sourceUpdatedAt": "2026-10-26T10:50:09.688Z",
          "shoe": 1648,
          "round": 3,
          "bankerCount": 0,
          "playerCount": 1,
          "tieCount": 0,
          "bankerPairCount": 0,
          "playerPairCount": 0
        },
        "derived_main_features": {
          "shoeStage": "early",
          "previousWinner": "player",
          "streakLength": 1,
          "near5BankerPlayerBias": -1,
          "roadTrend": null,
          "longDragon": false,
          "doubleDragon": false,
          "upSlope": false,
          "downSlope": false,
          "jumpPattern": false,
          "singleJump": false,
          "doubleJump": false,
          "threeJump": false,
          "fourJump": false,
          "shortDragon": false,
          "brokenDragon": false,
          "turnDragon": false,
          "oneBankerTwoPlayer": false,
          "onePlayerTwoBanker": false,
          "rowPairRun": false,
          "bankerThenJump": false,
          "playerThenJump": false,
          "bankerThenRun": false,
          "playerThenRun": false,
          "brokenSingleJump": false,
          "longDragonToSingleJump": false,
          "singleJumpToLongDragon": false,
          "roadBreak": false,
          "derivedRoadSync": "neutral",
          "askRoadTrend": "player",
          "roadmapTrendSignals": {
            "singleJump": false,
            "doubleJump": false,
            "longDragon": false,
            "brokenDragon": false,
            "shortDragon": false,
            "turnDragon": false,
            "slopeRoad": false,
            "threeRunRoad": false,
            "fourRunRoad": false
          },
          "roadStructureSignals": {
            "bigRoadDominant": "player",
            "beadRoadDominant": "player",
            "roadOrderly": false,
            "roadChaotic": false
          },
          "derivedRoadStructureSignals": {
            "bigEye": "neutral",
            "smallRoad": "neutral",
            "cockroachRoad": "neutral",
            "allRed": false,
            "allBlue": false,
            "mixed": false
          },
          "askRoadSignals": {
            "bankerAdvantage": 0,
            "playerAdvantage": 1,
            "preferred": "player",
            "gap": 1
          },
          "directionCalibration": "player_bias",
          "probabilityGap": 100,
          "tableRecentHitRate": null,
          "recentPracticalCalibration": {
            "settledDirectionalPredictionStats": null,
            "source": "unavailable",
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "shoeBankerPlayerBias": {
            "bankerCount": 0,
            "playerCount": 1,
            "gap": -1,
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "actualWinner": "tie"
        },
        "unified_main_scores": {
          "roadmap_trend_signals": {
            "banker": 0.5,
            "player": 0.5
          },
          "ask_road_signals": {
            "banker": 0.44,
            "player": 0.56
          },
          "recent_practical_calibration": {
            "banker": 0.5,
            "player": 0.5
          },
          "shoe_banker_player_bias": {
            "banker": 0.444444444444,
            "player": 0.555555555556
          },
          "neutral_reserve": {
            "banker": 0.5,
            "player": 0.5
          }
        },
        "road_features": {
          "beadPlateRaw": "01",
          "bigRoadRaw": "0801",
          "bigEyeRaw": "",
          "smallRoadRaw": "",
          "cockroachRaw": "",
          "nextBankerRaw": {
            "bead_plate": "0102",
            "big": "0801#0702",
            "big_eye": "",
            "small": "",
            "cockroach": ""
          },
          "nextPlayerRaw": {
            "bead_plate": "0101",
            "big": "0801,0701",
            "big_eye": "",
            "small": "",
            "cockroach": ""
          }
        },
        "card_shoe_features": {
          "playerCardFaces": [
            null,
            null,
            null
          ],
          "bankerCardFaces": [
            null,
            null,
            null
          ],
          "playerCardPoints": [
            null,
            null,
            null
          ],
          "bankerCardPoints": [
            null,
            null,
            null
          ],
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerNatural": false,
          "bankerNatural": false,
          "playerDrew": false,
          "bankerDrew": false,
          "remainingRankCounts": null,
          "remainingPointCounts": {
            "0": 128,
            "1": 32,
            "2": 32,
            "3": 32,
            "4": 32,
            "5": 32,
            "6": 32,
            "7": 32,
            "8": 32,
            "9": 32
          },
          "zeroPointRate": 30.77,
          "sixPointRate": 7.69,
          "highPointRate": 15.38,
          "lowPointRate": 23.08,
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_card_rank_features": {
          "remainingRankCounts": {
            "2": 0,
            "3": 0,
            "4": 0,
            "5": 0,
            "6": 0,
            "7": 0,
            "8": 0,
            "9": 0,
            "10": 0,
            "A": 0,
            "J": 0,
            "Q": 0,
            "K": 0
          },
          "remainingRankTotal": 0,
          "remainingRankFeatureScores": {
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0
          },
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_prediction_rank_inputs": {
          "tie": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "superSix": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          }
        },
        "point_features": {
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerDrew": false,
          "bankerDrew": false,
          "playerNatural": false,
          "bankerNatural": false
        },
        "side_weights": {
          "tie": {
            "tie_count": 0.1,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0.45,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0.15,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "superSix": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.35,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "bankerPair": {
            "tie_count": 0,
            "banker_pair_count": 0.2,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.2,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.35,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.1,
            "remaining_rank_pressure": 0.15,
            "remaining_rank_total": 0
          },
          "playerPair": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0.2,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.15,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.25,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.2,
            "remaining_rank_pressure": 0.2,
            "remaining_rank_total": 0
          },
          "bankerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0.15,
            "banker_natural": 0.1,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          },
          "playerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0.35,
            "banker_point": 0,
            "point_diff": 0.15,
            "banker_natural": 0,
            "player_natural": 0.1,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          }
        },
        "side_tuning": {
          "tie": {
            "targetActionRate": 0.15,
            "targetHitRate": 0.5
          },
          "superSix": {
            "targetActionRate": 0.1,
            "targetHitRate": 0.5
          },
          "bankerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "playerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "bankerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          },
          "playerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          }
        },
        "side_predictions": {
          "tie": 0,
          "superSix": 45.6875,
          "bankerPair": 37.70117647058824,
          "playerPair": 44.5,
          "bankerDragon": 29,
          "playerDragon": 66
        },
        "side_actions": {
          "tie": false,
          "superSix": false,
          "bankerPair": false,
          "playerPair": false,
          "bankerDragon": false,
          "playerDragon": false
        },
        "side_results": {
          "superSix": false,
          "bankerDragon": false,
          "playerDragon": false,
          "bankerPair": false,
          "playerPair": false
        },
        "table_performance": {
          "settledDirectionalPredictionStats": null,
          "directionalCalibrationSource": "unavailable",
          "recentHitRate": null,
          "recentPredictionCount": 0,
          "source": "unavailable",
          "calculable": false
        },
        "confidence_calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 37,
          "finalConfidence": 47
        },
        "main_streak_adjustment": {
          "applied": false,
          "reason": "v105_no_lock_risk",
          "confidencePenalty": 0,
          "finalConfidence": 47,
          "supportGroupCount": 1,
          "supportGroups": {
            "roadmap": false,
            "askRoad": true
          },
          "actionSuppressed": false
        },
        "v105_main_policy": {
          "strategyVersion": "v105",
          "diagnostics": {
            "direction": {
              "rawPredictedResult": "player",
              "rawScoreTotals": {
                "banker": 0.46405555555539996,
                "player": 0.5359444444446001
              },
              "finalScoreTotals": {
                "banker": 0.46405555555539996,
                "player": 0.5359444444446001
              },
              "askRoadSuppressed": false,
              "lockGuardPrimarySource": null
            },
            "calibration": {
              "directionContribution": 0,
              "source": "v104_shadow_final_only",
              "sampleCount": 0,
              "hitRate": null,
              "minimumSamples": 20,
              "mode": "neutral_shrinkage",
              "rawConfidence": 37,
              "finalConfidence": 47
            },
            "shoeBias": {
              "banker": 0.444444444444,
              "player": 0.555555555556,
              "sampleCount": 1,
              "rawBankerRate": 0,
              "posteriorBankerRate": 0.444444444444,
              "capped": false,
              "priorSampleSize": 8,
              "maximumEdge": 0.08
            },
            "roadCycles": {
              "main": {
                "detected": false,
                "direction": null,
                "source": "chronological_bead_reconstructed_big_road",
                "cycleStrengthEligible": false,
                "priorityEligible": false,
                "auxiliaryAgrees": 0,
                "auxiliaryConflicts": 0,
                "reasonText": null,
                "invalidReason": "no_complete_cycle"
              },
              "roadmapScore": {
                "banker": 0.5,
                "player": 0.5
              },
              "auxiliary": {
                "beadPlate": {
                  "cycle": {
                    "detected": false
                  },
                  "validationOnly": true,
                  "countedAsIndependentSupport": false
                },
                "bigEye": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "smallRoad": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "cockroach": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                }
              }
            },
            "v104Baseline": {
              "predictedResult": "player",
              "sameSideStreak": 1,
              "cycleApplied": false
            }
          }
        },
        "v105_side_policy": {
          "strategyVersion": "v105_副預測沿用v104正式規則",
          "predictions": {
            "tie": 0,
            "superSix": 45.6875,
            "bankerPair": 37.70117647058824,
            "playerPair": 44.5,
            "bankerDragon": 29,
            "playerDragon": 66
          },
          "actions": {
            "tie": false,
            "superSix": false,
            "bankerPair": false,
            "playerPair": false,
            "bankerDragon": false,
            "playerDragon": false
          },
          "diagnostics": {
            "rawPredictions": {
              "tie": 3.750000000000001,
              "superSix": 47.5,
              "bankerPair": 18.823529411764707,
              "playerPair": 30.625,
              "bankerDragon": 29,
              "playerDragon": 66
            },
            "scoreCalibration": {
              "method": "train_quantile_to_existing_threshold",
              "offsets": {
                "tie": -13.867936925098554,
                "superSix": -1.8125,
                "bankerPair": 18.877647058823527,
                "playerPair": 13.875,
                "bankerDragon": 0,
                "playerDragon": 0
              },
              "actionRateTargets": {
                "tie": 0.15,
                "superSix": 0.1,
                "bankerPair": 0.2,
                "playerPair": 0.2,
                "bankerDragon": 0.08,
                "playerDragon": 0.08
              }
            },
            "primitives": {
              "T": 0,
              "B": 0,
              "P": 100,
              "R": 50,
              "S": 30,
              "Q": 50,
              "XB": 0,
              "XP": 0,
              "DB": 30,
              "DP": 100,
              "A": 0,
              "Hpair": 100,
              "H6": 100
            },
            "residuals": {
              "bankerPair": 0,
              "playerPair": 0,
              "bankerDragonShared": 0,
              "bankerDragonResidual": 30
            },
            "rank": {
              "available": false,
              "fallback": "renormalize",
              "substituted": null,
              "excluded": [
                "Q",
                "R"
              ]
            },
            "effectiveCoefficients": {
              "tie": {
                "T": 0.6335413929040736,
                "A": 0.24145860709592637,
                "S": 0.12500000000000003,
                "R": 0
              },
              "bankerPair": {
                "Q": 0,
                "S": 0.23529411764705885,
                "XB": 0.23529411764705885,
                "RB": 0.4117647058823529,
                "Hpair": 0.11764705882352942
              },
              "playerPair": {
                "Q": 0,
                "S": 0.18749999999999997,
                "XP": 0.25,
                "RP": 0.3125,
                "Hpair": 0.25
              },
              "superSix": {
                "B": 0.4375,
                "H6": 0.4375,
                "R": 0,
                "S": 0.12500000000000003
              },
              "bankerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0,
                "banker_point": 0.35,
                "point_diff": 0.15,
                "banker_natural": 0.1,
                "player_natural": 0,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              },
              "playerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0.35,
                "banker_point": 0,
                "point_diff": 0.15,
                "banker_natural": 0,
                "player_natural": 0.1,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              }
            }
          }
        },
        "v105_v10_main_policy": {
          "strategyVersion": "v105",
          "releaseVersion": "v105-v10-main.26",
          "sourceStrategy": "v105",
          "structureEligible": false,
          "diagnostics": {
            "v7RoadCycle": {
              "roads": {
                "bigEye": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "smallRoad": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "cockroach": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "v8AskRoad": {
              "roads": {
                "bigEye": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "smallRoad": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "cockroach": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "recentPracticalCalibration": {
              "banker": 0.5,
              "player": 0.5
            },
            "shoeBankerPlayerBias": {
              "banker": 0.444444444444,
              "player": 0.555555555556
            },
            "uncommonRoadStructure": {
              "eligible": false,
              "direction": null,
              "reason": "insufficient_run_history",
              "source": null,
              "motifRunLengths": [],
              "repeats": 0,
              "phaseIndex": null,
              "currentPhase": "ineligible",
              "currentSide": "player",
              "currentRunLength": 1,
              "targetRunLength": null,
              "decodedRuns": [
                {
                  "side": "player",
                  "length": 1
                }
              ]
            }
          }
        }
      },
      "featureWeights": {
        "roadmap_trend_signals": 0.275,
        "ask_road_signals": 0.275,
        "shoe_banker_player_bias": 0.35,
        "neutral_reserve": 0.1
      },
      "releaseVersion": "v105-v10-main.26",
      "predictionTiming": "pre_result_context",
      "shadowOnly": false,
      "activationEligible": true,
      "memberVisible": true,
      "writesSideActions": true,
      "sameSideStreak": 1,
      "baselineV104PredictedResult": "player",
      "baselineV104SameSideStreak": 1,
      "cycleApplied": false,
      "independentSupportCount": 1,
      "shoeBiasSuppressed": false,
      "askRoadSuppressed": false,
      "lockRisk": false,
      "diagnostics": {
        "direction": {
          "rawPredictedResult": "player",
          "rawScoreTotals": {
            "banker": 0.46405555555539996,
            "player": 0.5359444444446001
          },
          "finalScoreTotals": {
            "banker": 0.46405555555539996,
            "player": 0.5359444444446001
          },
          "askRoadSuppressed": false,
          "lockGuardPrimarySource": null
        },
        "calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 37,
          "finalConfidence": 47
        },
        "shoeBias": {
          "banker": 0.444444444444,
          "player": 0.555555555556,
          "sampleCount": 1,
          "rawBankerRate": 0,
          "posteriorBankerRate": 0.444444444444,
          "capped": false,
          "priorSampleSize": 8,
          "maximumEdge": 0.08
        },
        "roadCycles": {
          "main": {
            "detected": false,
            "direction": null,
            "source": "chronological_bead_reconstructed_big_road",
            "cycleStrengthEligible": false,
            "priorityEligible": false,
            "auxiliaryAgrees": 0,
            "auxiliaryConflicts": 0,
            "reasonText": null,
            "invalidReason": "no_complete_cycle"
          },
          "roadmapScore": {
            "banker": 0.5,
            "player": 0.5
          },
          "auxiliary": {
            "beadPlate": {
              "cycle": {
                "detected": false
              },
              "validationOnly": true,
              "countedAsIndependentSupport": false
            },
            "bigEye": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "smallRoad": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "cockroach": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            }
          }
        },
        "v104Baseline": {
          "predictedResult": "player",
          "sameSideStreak": 1,
          "cycleApplied": false
        }
      },
      "v9BaseDirection": "player",
      "structureDiagnostics": {
        "eligible": false,
        "direction": null,
        "reason": "insufficient_run_history",
        "source": null,
        "motifRunLengths": [],
        "repeats": 0,
        "phaseIndex": null,
        "currentPhase": "ineligible",
        "currentSide": "player",
        "currentRunLength": 1,
        "targetRunLength": null,
        "decodedRuns": [
          {
            "side": "player",
            "length": 1
          }
        ]
      },
      "rankLedgerEvidence": null,
      "createdAtMs": 1793011809873
    }
  },
  "complete": {
    "tableId": "BAV03A",
    "trendBundle": {
      "schemaVersion": 1,
      "tableId": "BAV03A",
      "shoe": "1648",
      "completedRound": 2,
      "status": "available",
      "reason": "complete"
    },
    "displayName": "MT百家樂第4桌",
    "tableType": "BAC",
    "shoe": 1648,
    "round": 3,
    "bankerCount": 1,
    "playerCount": 1,
    "tieCount": 0,
    "bankerPairCount": 0,
    "playerPairCount": 0,
    "beadPlateRaw": "0102",
    "bigRoadRaw": "0801,,,,,#0602,,,,,",
    "bigEyeRaw": "",
    "smallRoadRaw": "",
    "cockroachRaw": "",
    "nextBankerRaw": {
      "bead_plate": "010202",
      "big": "0801,,,,,#0602,0702,,,,",
      "big_eye": "1,,,,,,,",
      "small": "",
      "cockroach": ""
    },
    "nextPlayerRaw": {
      "bead_plate": "010201",
      "big": "0801,,,,,#0602,,,,,#0701,,,,,",
      "big_eye": "2,,,,,,,",
      "small": "",
      "cockroach": ""
    },
    "dealerName": null,
    "totalPlayers": 0,
    "roomId": 51,
    "state": null,
    "orderState": null,
    "sourceUpdatedAt": "2026-10-26T10:50:09.730Z",
    "roundBasis": "visible",
    "buildVersion": "v105",
    "prediction": {
      "source": "backend",
      "buildVersion": "v105",
      "strategyVersion": "v105",
      "targetTableId": "BAV03A",
      "targetShoe": "1648",
      "targetRound": 3,
      "predictedResult": "player",
      "confidence": 47,
      "probabilities": {
        "banker": 0,
        "player": 100,
        "tie": 0
      },
      "scoreTotals": {
        "banker": 0.46405555555539996,
        "player": 0.5359444444446001
      },
      "scoreSources": {
        "roadmap_trend_signals": {
          "banker": 0.5,
          "player": 0.5
        },
        "ask_road_signals": {
          "banker": 0.44,
          "player": 0.56
        },
        "recent_practical_calibration": {
          "banker": 0.5,
          "player": 0.5
        },
        "shoe_banker_player_bias": {
          "banker": 0.444444444444,
          "player": 0.555555555556
        },
        "neutral_reserve": {
          "banker": 0.5,
          "player": 0.5
        }
      },
      "sidePredictions": {
        "tie": 0,
        "superSix": 45.6875,
        "bankerPair": 37.70117647058824,
        "playerPair": 44.5,
        "bankerDragon": 29,
        "playerDragon": 66
      },
      "sideActions": {
        "tie": false,
        "superSix": false,
        "bankerPair": false,
        "playerPair": false,
        "bankerDragon": false,
        "playerDragon": false
      },
      "mainStreakAdjustment": {
        "applied": false,
        "reason": "v105_no_lock_risk",
        "confidencePenalty": 0,
        "finalConfidence": 47,
        "supportGroupCount": 1,
        "supportGroups": {
          "roadmap": false,
          "askRoad": true
        },
        "actionSuppressed": false
      },
      "tableRecentHitRate": null,
      "tableRecentPredictionCount": 0,
      "shortRunAdjustment": {
        "rule": "v105",
        "includedMainWeightCount": 5,
        "includedSideWeightCount": 28,
        "sideActionRateTargets": {
          "tie": 0.15,
          "superSix": 0.1,
          "bankerPair": 0.2,
          "playerPair": 0.2,
          "bankerDragon": 0.08,
          "playerDragon": 0.08
        },
        "sideTargetHitRate": 0.5,
        "baseProbabilities": {
          "banker": 0,
          "player": 100,
          "tie": 0
        }
      },
      "predictionFeatures": {
        "prediction_timing": "pre_result_context",
        "mt_context": {
          "tableId": "BAV03A",
          "displayName": "MT百家樂第4桌",
          "tableType": "BAC",
          "roomId": 51,
          "dealerName": null,
          "totalPlayers": 0,
          "state": null,
          "orderState": null,
          "sourceUpdatedAt": "2026-10-26T10:50:09.688Z",
          "shoe": 1648,
          "round": 3,
          "bankerCount": 0,
          "playerCount": 1,
          "tieCount": 0,
          "bankerPairCount": 0,
          "playerPairCount": 0
        },
        "derived_main_features": {
          "shoeStage": "early",
          "previousWinner": "player",
          "streakLength": 1,
          "near5BankerPlayerBias": -1,
          "roadTrend": null,
          "longDragon": false,
          "doubleDragon": false,
          "upSlope": false,
          "downSlope": false,
          "jumpPattern": false,
          "singleJump": false,
          "doubleJump": false,
          "threeJump": false,
          "fourJump": false,
          "shortDragon": false,
          "brokenDragon": false,
          "turnDragon": false,
          "oneBankerTwoPlayer": false,
          "onePlayerTwoBanker": false,
          "rowPairRun": false,
          "bankerThenJump": false,
          "playerThenJump": false,
          "bankerThenRun": false,
          "playerThenRun": false,
          "brokenSingleJump": false,
          "longDragonToSingleJump": false,
          "singleJumpToLongDragon": false,
          "roadBreak": false,
          "derivedRoadSync": "neutral",
          "askRoadTrend": "player",
          "roadmapTrendSignals": {
            "singleJump": false,
            "doubleJump": false,
            "longDragon": false,
            "brokenDragon": false,
            "shortDragon": false,
            "turnDragon": false,
            "slopeRoad": false,
            "threeRunRoad": false,
            "fourRunRoad": false
          },
          "roadStructureSignals": {
            "bigRoadDominant": "player",
            "beadRoadDominant": "player",
            "roadOrderly": false,
            "roadChaotic": false
          },
          "derivedRoadStructureSignals": {
            "bigEye": "neutral",
            "smallRoad": "neutral",
            "cockroachRoad": "neutral",
            "allRed": false,
            "allBlue": false,
            "mixed": false
          },
          "askRoadSignals": {
            "bankerAdvantage": 0,
            "playerAdvantage": 1,
            "preferred": "player",
            "gap": 1
          },
          "directionCalibration": "player_bias",
          "probabilityGap": 100,
          "tableRecentHitRate": null,
          "recentPracticalCalibration": {
            "settledDirectionalPredictionStats": null,
            "source": "unavailable",
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "shoeBankerPlayerBias": {
            "bankerCount": 0,
            "playerCount": 1,
            "gap": -1,
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "actualWinner": "tie"
        },
        "unified_main_scores": {
          "roadmap_trend_signals": {
            "banker": 0.5,
            "player": 0.5
          },
          "ask_road_signals": {
            "banker": 0.44,
            "player": 0.56
          },
          "recent_practical_calibration": {
            "banker": 0.5,
            "player": 0.5
          },
          "shoe_banker_player_bias": {
            "banker": 0.444444444444,
            "player": 0.555555555556
          },
          "neutral_reserve": {
            "banker": 0.5,
            "player": 0.5
          }
        },
        "road_features": {
          "beadPlateRaw": "01",
          "bigRoadRaw": "0801",
          "bigEyeRaw": "",
          "smallRoadRaw": "",
          "cockroachRaw": "",
          "nextBankerRaw": {
            "bead_plate": "0102",
            "big": "0801#0702",
            "big_eye": "",
            "small": "",
            "cockroach": ""
          },
          "nextPlayerRaw": {
            "bead_plate": "0101",
            "big": "0801,0701",
            "big_eye": "",
            "small": "",
            "cockroach": ""
          }
        },
        "card_shoe_features": {
          "playerCardFaces": [
            null,
            null,
            null
          ],
          "bankerCardFaces": [
            null,
            null,
            null
          ],
          "playerCardPoints": [
            null,
            null,
            null
          ],
          "bankerCardPoints": [
            null,
            null,
            null
          ],
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerNatural": false,
          "bankerNatural": false,
          "playerDrew": false,
          "bankerDrew": false,
          "remainingRankCounts": null,
          "remainingPointCounts": {
            "0": 128,
            "1": 32,
            "2": 32,
            "3": 32,
            "4": 32,
            "5": 32,
            "6": 32,
            "7": 32,
            "8": 32,
            "9": 32
          },
          "zeroPointRate": 30.77,
          "sixPointRate": 7.69,
          "highPointRate": 15.38,
          "lowPointRate": 23.08,
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_card_rank_features": {
          "remainingRankCounts": {
            "2": 0,
            "3": 0,
            "4": 0,
            "5": 0,
            "6": 0,
            "7": 0,
            "8": 0,
            "9": 0,
            "10": 0,
            "A": 0,
            "J": 0,
            "Q": 0,
            "K": 0
          },
          "remainingRankTotal": 0,
          "remainingRankFeatureScores": {
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0
          },
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_prediction_rank_inputs": {
          "tie": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "superSix": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          }
        },
        "point_features": {
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerDrew": false,
          "bankerDrew": false,
          "playerNatural": false,
          "bankerNatural": false
        },
        "side_weights": {
          "tie": {
            "tie_count": 0.1,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0.45,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0.15,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "superSix": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.35,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "bankerPair": {
            "tie_count": 0,
            "banker_pair_count": 0.2,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.2,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.35,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.1,
            "remaining_rank_pressure": 0.15,
            "remaining_rank_total": 0
          },
          "playerPair": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0.2,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.15,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.25,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.2,
            "remaining_rank_pressure": 0.2,
            "remaining_rank_total": 0
          },
          "bankerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0.15,
            "banker_natural": 0.1,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          },
          "playerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0.35,
            "banker_point": 0,
            "point_diff": 0.15,
            "banker_natural": 0,
            "player_natural": 0.1,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          }
        },
        "side_tuning": {
          "tie": {
            "targetActionRate": 0.15,
            "targetHitRate": 0.5
          },
          "superSix": {
            "targetActionRate": 0.1,
            "targetHitRate": 0.5
          },
          "bankerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "playerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "bankerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          },
          "playerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          }
        },
        "side_predictions": {
          "tie": 0,
          "superSix": 45.6875,
          "bankerPair": 37.70117647058824,
          "playerPair": 44.5,
          "bankerDragon": 29,
          "playerDragon": 66
        },
        "side_actions": {
          "tie": false,
          "superSix": false,
          "bankerPair": false,
          "playerPair": false,
          "bankerDragon": false,
          "playerDragon": false
        },
        "side_results": {
          "superSix": false,
          "bankerDragon": false,
          "playerDragon": false,
          "bankerPair": false,
          "playerPair": false
        },
        "table_performance": {
          "settledDirectionalPredictionStats": null,
          "directionalCalibrationSource": "unavailable",
          "recentHitRate": null,
          "recentPredictionCount": 0,
          "source": "unavailable",
          "calculable": false
        },
        "confidence_calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 37,
          "finalConfidence": 47
        },
        "main_streak_adjustment": {
          "applied": false,
          "reason": "v105_no_lock_risk",
          "confidencePenalty": 0,
          "finalConfidence": 47,
          "supportGroupCount": 1,
          "supportGroups": {
            "roadmap": false,
            "askRoad": true
          },
          "actionSuppressed": false
        },
        "v105_main_policy": {
          "strategyVersion": "v105",
          "diagnostics": {
            "direction": {
              "rawPredictedResult": "player",
              "rawScoreTotals": {
                "banker": 0.46405555555539996,
                "player": 0.5359444444446001
              },
              "finalScoreTotals": {
                "banker": 0.46405555555539996,
                "player": 0.5359444444446001
              },
              "askRoadSuppressed": false,
              "lockGuardPrimarySource": null
            },
            "calibration": {
              "directionContribution": 0,
              "source": "v104_shadow_final_only",
              "sampleCount": 0,
              "hitRate": null,
              "minimumSamples": 20,
              "mode": "neutral_shrinkage",
              "rawConfidence": 37,
              "finalConfidence": 47
            },
            "shoeBias": {
              "banker": 0.444444444444,
              "player": 0.555555555556,
              "sampleCount": 1,
              "rawBankerRate": 0,
              "posteriorBankerRate": 0.444444444444,
              "capped": false,
              "priorSampleSize": 8,
              "maximumEdge": 0.08
            },
            "roadCycles": {
              "main": {
                "detected": false,
                "direction": null,
                "source": "chronological_bead_reconstructed_big_road",
                "cycleStrengthEligible": false,
                "priorityEligible": false,
                "auxiliaryAgrees": 0,
                "auxiliaryConflicts": 0,
                "reasonText": null,
                "invalidReason": "no_complete_cycle"
              },
              "roadmapScore": {
                "banker": 0.5,
                "player": 0.5
              },
              "auxiliary": {
                "beadPlate": {
                  "cycle": {
                    "detected": false
                  },
                  "validationOnly": true,
                  "countedAsIndependentSupport": false
                },
                "bigEye": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "smallRoad": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "cockroach": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                }
              }
            },
            "v104Baseline": {
              "predictedResult": "player",
              "sameSideStreak": 1,
              "cycleApplied": false
            }
          }
        },
        "v105_side_policy": {
          "strategyVersion": "v105_副預測沿用v104正式規則",
          "predictions": {
            "tie": 0,
            "superSix": 45.6875,
            "bankerPair": 37.70117647058824,
            "playerPair": 44.5,
            "bankerDragon": 29,
            "playerDragon": 66
          },
          "actions": {
            "tie": false,
            "superSix": false,
            "bankerPair": false,
            "playerPair": false,
            "bankerDragon": false,
            "playerDragon": false
          },
          "diagnostics": {
            "rawPredictions": {
              "tie": 3.750000000000001,
              "superSix": 47.5,
              "bankerPair": 18.823529411764707,
              "playerPair": 30.625,
              "bankerDragon": 29,
              "playerDragon": 66
            },
            "scoreCalibration": {
              "method": "train_quantile_to_existing_threshold",
              "offsets": {
                "tie": -13.867936925098554,
                "superSix": -1.8125,
                "bankerPair": 18.877647058823527,
                "playerPair": 13.875,
                "bankerDragon": 0,
                "playerDragon": 0
              },
              "actionRateTargets": {
                "tie": 0.15,
                "superSix": 0.1,
                "bankerPair": 0.2,
                "playerPair": 0.2,
                "bankerDragon": 0.08,
                "playerDragon": 0.08
              }
            },
            "primitives": {
              "T": 0,
              "B": 0,
              "P": 100,
              "R": 50,
              "S": 30,
              "Q": 50,
              "XB": 0,
              "XP": 0,
              "DB": 30,
              "DP": 100,
              "A": 0,
              "Hpair": 100,
              "H6": 100
            },
            "residuals": {
              "bankerPair": 0,
              "playerPair": 0,
              "bankerDragonShared": 0,
              "bankerDragonResidual": 30
            },
            "rank": {
              "available": false,
              "fallback": "renormalize",
              "substituted": null,
              "excluded": [
                "Q",
                "R"
              ]
            },
            "effectiveCoefficients": {
              "tie": {
                "T": 0.6335413929040736,
                "A": 0.24145860709592637,
                "S": 0.12500000000000003,
                "R": 0
              },
              "bankerPair": {
                "Q": 0,
                "S": 0.23529411764705885,
                "XB": 0.23529411764705885,
                "RB": 0.4117647058823529,
                "Hpair": 0.11764705882352942
              },
              "playerPair": {
                "Q": 0,
                "S": 0.18749999999999997,
                "XP": 0.25,
                "RP": 0.3125,
                "Hpair": 0.25
              },
              "superSix": {
                "B": 0.4375,
                "H6": 0.4375,
                "R": 0,
                "S": 0.12500000000000003
              },
              "bankerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0,
                "banker_point": 0.35,
                "point_diff": 0.15,
                "banker_natural": 0.1,
                "player_natural": 0,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              },
              "playerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0.35,
                "banker_point": 0,
                "point_diff": 0.15,
                "banker_natural": 0,
                "player_natural": 0.1,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              }
            }
          }
        },
        "v105_v10_main_policy": {
          "strategyVersion": "v105",
          "releaseVersion": "v105-v10-main.26",
          "sourceStrategy": "v105",
          "structureEligible": false,
          "diagnostics": {
            "v7RoadCycle": {
              "roads": {
                "bigEye": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "smallRoad": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "cockroach": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "v8AskRoad": {
              "roads": {
                "bigEye": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "smallRoad": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "cockroach": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "recentPracticalCalibration": {
              "banker": 0.5,
              "player": 0.5
            },
            "shoeBankerPlayerBias": {
              "banker": 0.444444444444,
              "player": 0.555555555556
            },
            "uncommonRoadStructure": {
              "eligible": false,
              "direction": null,
              "reason": "insufficient_run_history",
              "source": null,
              "motifRunLengths": [],
              "repeats": 0,
              "phaseIndex": null,
              "currentPhase": "ineligible",
              "currentSide": "player",
              "currentRunLength": 1,
              "targetRunLength": null,
              "decodedRuns": [
                {
                  "side": "player",
                  "length": 1
                }
              ]
            }
          }
        }
      },
      "featureWeights": {
        "roadmap_trend_signals": 0.275,
        "ask_road_signals": 0.275,
        "shoe_banker_player_bias": 0.35,
        "neutral_reserve": 0.1
      },
      "releaseVersion": "v105-v10-main.26",
      "predictionTiming": "pre_result_context",
      "shadowOnly": false,
      "activationEligible": true,
      "memberVisible": true,
      "writesSideActions": true,
      "sameSideStreak": 1,
      "baselineV104PredictedResult": "player",
      "baselineV104SameSideStreak": 1,
      "cycleApplied": false,
      "independentSupportCount": 1,
      "shoeBiasSuppressed": false,
      "askRoadSuppressed": false,
      "lockRisk": false,
      "diagnostics": {
        "direction": {
          "rawPredictedResult": "player",
          "rawScoreTotals": {
            "banker": 0.46405555555539996,
            "player": 0.5359444444446001
          },
          "finalScoreTotals": {
            "banker": 0.46405555555539996,
            "player": 0.5359444444446001
          },
          "askRoadSuppressed": false,
          "lockGuardPrimarySource": null
        },
        "calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 37,
          "finalConfidence": 47
        },
        "shoeBias": {
          "banker": 0.444444444444,
          "player": 0.555555555556,
          "sampleCount": 1,
          "rawBankerRate": 0,
          "posteriorBankerRate": 0.444444444444,
          "capped": false,
          "priorSampleSize": 8,
          "maximumEdge": 0.08
        },
        "roadCycles": {
          "main": {
            "detected": false,
            "direction": null,
            "source": "chronological_bead_reconstructed_big_road",
            "cycleStrengthEligible": false,
            "priorityEligible": false,
            "auxiliaryAgrees": 0,
            "auxiliaryConflicts": 0,
            "reasonText": null,
            "invalidReason": "no_complete_cycle"
          },
          "roadmapScore": {
            "banker": 0.5,
            "player": 0.5
          },
          "auxiliary": {
            "beadPlate": {
              "cycle": {
                "detected": false
              },
              "validationOnly": true,
              "countedAsIndependentSupport": false
            },
            "bigEye": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "smallRoad": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "cockroach": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            }
          }
        },
        "v104Baseline": {
          "predictedResult": "player",
          "sameSideStreak": 1,
          "cycleApplied": false
        }
      },
      "v9BaseDirection": "player",
      "structureDiagnostics": {
        "eligible": false,
        "direction": null,
        "reason": "insufficient_run_history",
        "source": null,
        "motifRunLengths": [],
        "repeats": 0,
        "phaseIndex": null,
        "currentPhase": "ineligible",
        "currentSide": "player",
        "currentRunLength": 1,
        "targetRunLength": null,
        "decodedRuns": [
          {
            "side": "player",
            "length": 1
          }
        ]
      },
      "rankLedgerEvidence": null,
      "createdAtMs": 1793011809873
    }
  },
  "gap": {
    "tableId": "BAV03A",
    "trendBundle": {
      "schemaVersion": 1,
      "tableId": "BAV03A",
      "shoe": "1648",
      "completedRound": 2,
      "status": "pending",
      "reason": "coverage-mismatch"
    },
    "displayName": "MT百家樂第4桌",
    "tableType": "BAC",
    "shoe": 1648,
    "round": 5,
    "bankerCount": 1,
    "playerCount": 1,
    "tieCount": 0,
    "bankerPairCount": 0,
    "playerPairCount": 0,
    "beadPlateRaw": "0102",
    "bigRoadRaw": "0801,,,,,#0602,,,,,",
    "bigEyeRaw": "",
    "smallRoadRaw": "",
    "cockroachRaw": "",
    "nextBankerRaw": {
      "bead_plate": "010202",
      "big": "0801,,,,,#0602,0702,,,,",
      "big_eye": "1,,,,,,,",
      "small": "",
      "cockroach": ""
    },
    "nextPlayerRaw": {
      "bead_plate": "010201",
      "big": "0801,,,,,#0602,,,,,#0701,,,,,",
      "big_eye": "2,,,,,,,",
      "small": "",
      "cockroach": ""
    },
    "dealerName": null,
    "totalPlayers": 0,
    "roomId": 51,
    "state": null,
    "orderState": null,
    "sourceUpdatedAt": "2026-10-26T10:50:09.812Z",
    "roundBasis": "visible",
    "buildVersion": "v105",
    "prediction": {
      "source": "backend",
      "buildVersion": "v105",
      "strategyVersion": "v105",
      "targetTableId": "BAV03A",
      "targetShoe": "1648",
      "targetRound": 5,
      "predictedResult": "banker",
      "confidence": 47,
      "probabilities": {
        "banker": 50,
        "player": 50,
        "tie": 0
      },
      "scoreTotals": {
        "banker": 0.51375,
        "player": 0.48625
      },
      "scoreSources": {
        "roadmap_trend_signals": {
          "banker": 0.55,
          "player": 0.45
        },
        "ask_road_signals": {
          "banker": 0.5,
          "player": 0.5
        },
        "recent_practical_calibration": {
          "banker": 0.5,
          "player": 0.5
        },
        "shoe_banker_player_bias": {
          "banker": 0.5,
          "player": 0.5
        },
        "neutral_reserve": {
          "banker": 0.5,
          "player": 0.5
        }
      },
      "sidePredictions": {
        "tie": 14.027923784494082,
        "superSix": 39.125,
        "bankerPair": 30.054117647058824,
        "playerPair": 28.25,
        "bankerDragon": 26,
        "playerDragon": 26
      },
      "sideActions": {
        "tie": false,
        "superSix": false,
        "bankerPair": false,
        "playerPair": false,
        "bankerDragon": false,
        "playerDragon": false
      },
      "mainStreakAdjustment": {
        "applied": false,
        "reason": "v105_no_lock_risk",
        "confidencePenalty": 0,
        "finalConfidence": 47,
        "supportGroupCount": 1,
        "supportGroups": {
          "roadmap": true,
          "askRoad": false
        },
        "actionSuppressed": false
      },
      "tableRecentHitRate": null,
      "tableRecentPredictionCount": 0,
      "shortRunAdjustment": {
        "rule": "v105",
        "includedMainWeightCount": 5,
        "includedSideWeightCount": 28,
        "sideActionRateTargets": {
          "tie": 0.15,
          "superSix": 0.1,
          "bankerPair": 0.2,
          "playerPair": 0.2,
          "bankerDragon": 0.08,
          "playerDragon": 0.08
        },
        "sideTargetHitRate": 0.5,
        "baseProbabilities": {
          "banker": 50,
          "player": 50,
          "tie": 0
        }
      },
      "predictionFeatures": {
        "prediction_timing": "pre_result_context",
        "mt_context": {
          "tableId": "BAV03A",
          "displayName": "MT百家樂第4桌",
          "tableType": "BAC",
          "roomId": 51,
          "dealerName": null,
          "totalPlayers": 0,
          "state": null,
          "orderState": null,
          "sourceUpdatedAt": "2026-10-26T10:50:09.812Z",
          "shoe": 1648,
          "round": 5,
          "bankerCount": 1,
          "playerCount": 1,
          "tieCount": 0,
          "bankerPairCount": 0,
          "playerPairCount": 0
        },
        "derived_main_features": {
          "shoeStage": "early",
          "previousWinner": "banker",
          "streakLength": 1,
          "near5BankerPlayerBias": 0,
          "roadTrend": "banker",
          "longDragon": false,
          "doubleDragon": false,
          "upSlope": false,
          "downSlope": false,
          "jumpPattern": false,
          "singleJump": false,
          "doubleJump": false,
          "threeJump": false,
          "fourJump": false,
          "shortDragon": false,
          "brokenDragon": false,
          "turnDragon": false,
          "oneBankerTwoPlayer": false,
          "onePlayerTwoBanker": false,
          "rowPairRun": false,
          "bankerThenJump": false,
          "playerThenJump": false,
          "bankerThenRun": false,
          "playerThenRun": false,
          "brokenSingleJump": false,
          "longDragonToSingleJump": false,
          "singleJumpToLongDragon": false,
          "roadBreak": true,
          "derivedRoadSync": "neutral",
          "askRoadTrend": "neutral",
          "roadmapTrendSignals": {
            "singleJump": false,
            "doubleJump": false,
            "longDragon": false,
            "brokenDragon": false,
            "shortDragon": false,
            "turnDragon": false,
            "slopeRoad": false,
            "threeRunRoad": false,
            "fourRunRoad": false
          },
          "roadStructureSignals": {
            "bigRoadDominant": "neutral",
            "beadRoadDominant": "neutral",
            "roadOrderly": false,
            "roadChaotic": true
          },
          "derivedRoadStructureSignals": {
            "bigEye": "neutral",
            "smallRoad": "neutral",
            "cockroachRoad": "neutral",
            "allRed": false,
            "allBlue": false,
            "mixed": false
          },
          "askRoadSignals": {
            "bankerAdvantage": 0.555556,
            "playerAdvantage": 0.555556,
            "preferred": "neutral",
            "gap": 0
          },
          "directionCalibration": "banker_bias",
          "probabilityGap": 0,
          "tableRecentHitRate": null,
          "recentPracticalCalibration": {
            "settledDirectionalPredictionStats": null,
            "source": "unavailable",
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "shoeBankerPlayerBias": {
            "bankerCount": 1,
            "playerCount": 1,
            "gap": 0,
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "actualWinner": "tie"
        },
        "unified_main_scores": {
          "roadmap_trend_signals": {
            "banker": 0.55,
            "player": 0.45
          },
          "ask_road_signals": {
            "banker": 0.5,
            "player": 0.5
          },
          "recent_practical_calibration": {
            "banker": 0.5,
            "player": 0.5
          },
          "shoe_banker_player_bias": {
            "banker": 0.5,
            "player": 0.5
          },
          "neutral_reserve": {
            "banker": 0.5,
            "player": 0.5
          }
        },
        "road_features": {
          "beadPlateRaw": "0102",
          "bigRoadRaw": "0801,,,,,#0602,,,,,",
          "bigEyeRaw": "",
          "smallRoadRaw": "",
          "cockroachRaw": "",
          "nextBankerRaw": {
            "bead_plate": "010202",
            "big": "0801,,,,,#0602,0702,,,,",
            "big_eye": "1,,,,,,,",
            "small": "",
            "cockroach": ""
          },
          "nextPlayerRaw": {
            "bead_plate": "010201",
            "big": "0801,,,,,#0602,,,,,#0701,,,,,",
            "big_eye": "2,,,,,,,",
            "small": "",
            "cockroach": ""
          }
        },
        "card_shoe_features": {
          "playerCardFaces": [
            null,
            null,
            null
          ],
          "bankerCardFaces": [
            null,
            null,
            null
          ],
          "playerCardPoints": [
            null,
            null,
            null
          ],
          "bankerCardPoints": [
            null,
            null,
            null
          ],
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerNatural": false,
          "bankerNatural": false,
          "playerDrew": false,
          "bankerDrew": false,
          "remainingRankCounts": null,
          "remainingPointCounts": {
            "0": 128,
            "1": 32,
            "2": 32,
            "3": 32,
            "4": 32,
            "5": 32,
            "6": 32,
            "7": 32,
            "8": 32,
            "9": 32
          },
          "zeroPointRate": 30.77,
          "sixPointRate": 7.69,
          "highPointRate": 15.38,
          "lowPointRate": 23.08,
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_card_rank_features": {
          "remainingRankCounts": {
            "2": 0,
            "3": 0,
            "4": 0,
            "5": 0,
            "6": 0,
            "7": 0,
            "8": 0,
            "9": 0,
            "10": 0,
            "A": 0,
            "J": 0,
            "Q": 0,
            "K": 0
          },
          "remainingRankTotal": 0,
          "remainingRankFeatureScores": {
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0
          },
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_prediction_rank_inputs": {
          "tie": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "superSix": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          }
        },
        "point_features": {
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerDrew": false,
          "bankerDrew": false,
          "playerNatural": false,
          "bankerNatural": false
        },
        "side_weights": {
          "tie": {
            "tie_count": 0.1,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0.45,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0.15,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "superSix": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.35,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "bankerPair": {
            "tie_count": 0,
            "banker_pair_count": 0.2,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.2,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.35,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.1,
            "remaining_rank_pressure": 0.15,
            "remaining_rank_total": 0
          },
          "playerPair": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0.2,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.15,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.25,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.2,
            "remaining_rank_pressure": 0.2,
            "remaining_rank_total": 0
          },
          "bankerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0.15,
            "banker_natural": 0.1,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          },
          "playerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0.35,
            "banker_point": 0,
            "point_diff": 0.15,
            "banker_natural": 0,
            "player_natural": 0.1,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          }
        },
        "side_tuning": {
          "tie": {
            "targetActionRate": 0.15,
            "targetHitRate": 0.5
          },
          "superSix": {
            "targetActionRate": 0.1,
            "targetHitRate": 0.5
          },
          "bankerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "playerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "bankerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          },
          "playerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          }
        },
        "side_predictions": {
          "tie": 14.027923784494082,
          "superSix": 39.125,
          "bankerPair": 30.054117647058824,
          "playerPair": 28.25,
          "bankerDragon": 26,
          "playerDragon": 26
        },
        "side_actions": {
          "tie": false,
          "superSix": false,
          "bankerPair": false,
          "playerPair": false,
          "bankerDragon": false,
          "playerDragon": false
        },
        "side_results": {
          "superSix": false,
          "bankerDragon": false,
          "playerDragon": false,
          "bankerPair": false,
          "playerPair": false
        },
        "table_performance": {
          "settledDirectionalPredictionStats": null,
          "directionalCalibrationSource": "unavailable",
          "recentHitRate": null,
          "recentPredictionCount": 0,
          "source": "unavailable",
          "calculable": false
        },
        "confidence_calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 33,
          "finalConfidence": 47
        },
        "main_streak_adjustment": {
          "applied": false,
          "reason": "v105_no_lock_risk",
          "confidencePenalty": 0,
          "finalConfidence": 47,
          "supportGroupCount": 1,
          "supportGroups": {
            "roadmap": true,
            "askRoad": false
          },
          "actionSuppressed": false
        },
        "v105_main_policy": {
          "strategyVersion": "v105",
          "diagnostics": {
            "direction": {
              "rawPredictedResult": "banker",
              "rawScoreTotals": {
                "banker": 0.51375,
                "player": 0.48625
              },
              "finalScoreTotals": {
                "banker": 0.51375,
                "player": 0.48625
              },
              "askRoadSuppressed": false,
              "lockGuardPrimarySource": null
            },
            "calibration": {
              "directionContribution": 0,
              "source": "v104_shadow_final_only",
              "sampleCount": 0,
              "hitRate": null,
              "minimumSamples": 20,
              "mode": "neutral_shrinkage",
              "rawConfidence": 33,
              "finalConfidence": 47
            },
            "shoeBias": {
              "banker": 0.5,
              "player": 0.5,
              "sampleCount": 2,
              "rawBankerRate": 0.5,
              "posteriorBankerRate": 0.5,
              "capped": false,
              "priorSampleSize": 8,
              "maximumEdge": 0.08
            },
            "roadCycles": {
              "main": {
                "detected": false,
                "direction": null,
                "source": "chronological_bead_reconstructed_big_road",
                "cycleStrengthEligible": false,
                "priorityEligible": false,
                "auxiliaryAgrees": 0,
                "auxiliaryConflicts": 0,
                "reasonText": null,
                "invalidReason": "no_complete_cycle"
              },
              "roadmapScore": {
                "banker": 0.5,
                "player": 0.5
              },
              "auxiliary": {
                "beadPlate": {
                  "cycle": {
                    "detected": false
                  },
                  "validationOnly": true,
                  "countedAsIndependentSupport": false
                },
                "bigEye": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "smallRoad": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "cockroach": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                }
              }
            },
            "v104Baseline": {
              "predictedResult": "banker",
              "sameSideStreak": 1,
              "cycleApplied": false
            }
          }
        },
        "v105_side_policy": {
          "strategyVersion": "v105_副預測沿用v104正式規則",
          "predictions": {
            "tie": 14.027923784494082,
            "superSix": 39.125,
            "bankerPair": 30.054117647058824,
            "playerPair": 28.25,
            "bankerDragon": 26,
            "playerDragon": 26
          },
          "actions": {
            "tie": false,
            "superSix": false,
            "bankerPair": false,
            "playerPair": false,
            "bankerDragon": false,
            "playerDragon": false
          },
          "diagnostics": {
            "rawPredictions": {
              "tie": 27.895860709592636,
              "superSix": 40.9375,
              "bankerPair": 11.176470588235295,
              "playerPair": 14.375,
              "bankerDragon": 26,
              "playerDragon": 26
            },
            "scoreCalibration": {
              "method": "train_quantile_to_existing_threshold",
              "offsets": {
                "tie": -13.867936925098554,
                "superSix": -1.8125,
                "bankerPair": 18.877647058823527,
                "playerPair": 13.875,
                "bankerDragon": 0,
                "playerDragon": 0
              },
              "actionRateTargets": {
                "tie": 0.15,
                "superSix": 0.1,
                "bankerPair": 0.2,
                "playerPair": 0.2,
                "bankerDragon": 0.08,
                "playerDragon": 0.08
              }
            },
            "primitives": {
              "T": 0,
              "B": 50,
              "P": 50,
              "R": 50,
              "S": 30,
              "Q": 50,
              "XB": 0,
              "XP": 0,
              "DB": 35,
              "DP": 35,
              "A": 100,
              "Hpair": 35,
              "H6": 35
            },
            "residuals": {
              "bankerPair": 0,
              "playerPair": 0,
              "bankerDragonShared": 35,
              "bankerDragonResidual": 0
            },
            "rank": {
              "available": false,
              "fallback": "renormalize",
              "substituted": null,
              "excluded": [
                "Q",
                "R"
              ]
            },
            "effectiveCoefficients": {
              "tie": {
                "T": 0.6335413929040736,
                "A": 0.24145860709592637,
                "S": 0.12500000000000003,
                "R": 0
              },
              "bankerPair": {
                "Q": 0,
                "S": 0.23529411764705885,
                "XB": 0.23529411764705885,
                "RB": 0.4117647058823529,
                "Hpair": 0.11764705882352942
              },
              "playerPair": {
                "Q": 0,
                "S": 0.18749999999999997,
                "XP": 0.25,
                "RP": 0.3125,
                "Hpair": 0.25
              },
              "superSix": {
                "B": 0.4375,
                "H6": 0.4375,
                "R": 0,
                "S": 0.12500000000000003
              },
              "bankerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0,
                "banker_point": 0.35,
                "point_diff": 0.15,
                "banker_natural": 0.1,
                "player_natural": 0,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              },
              "playerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0.35,
                "banker_point": 0,
                "point_diff": 0.15,
                "banker_natural": 0,
                "player_natural": 0.1,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              }
            }
          }
        },
        "v105_v10_main_policy": {
          "strategyVersion": "v105",
          "releaseVersion": "v105-v10-main.26",
          "sourceStrategy": "v105",
          "structureEligible": false,
          "diagnostics": {
            "v7RoadCycle": {
              "roads": {
                "bigEye": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": "1",
                  "playerNextColor": "2",
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "smallRoad": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "cockroach": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "v8AskRoad": {
              "roads": {
                "bigEye": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "smallRoad": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "cockroach": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "recentPracticalCalibration": {
              "banker": 0.5,
              "player": 0.5
            },
            "shoeBankerPlayerBias": {
              "banker": 0.5,
              "player": 0.5
            },
            "uncommonRoadStructure": {
              "eligible": false,
              "direction": null,
              "reason": "insufficient_run_history",
              "source": null,
              "motifRunLengths": [],
              "repeats": 0,
              "phaseIndex": null,
              "currentPhase": "ineligible",
              "currentSide": "banker",
              "currentRunLength": 1,
              "targetRunLength": null,
              "decodedRuns": [
                {
                  "side": "player",
                  "length": 1
                },
                {
                  "side": "banker",
                  "length": 1
                }
              ]
            }
          }
        }
      },
      "featureWeights": {
        "roadmap_trend_signals": 0.275,
        "ask_road_signals": 0.275,
        "shoe_banker_player_bias": 0.35,
        "neutral_reserve": 0.1
      },
      "releaseVersion": "v105-v10-main.26",
      "predictionTiming": "pre_result_context",
      "shadowOnly": false,
      "activationEligible": true,
      "memberVisible": true,
      "writesSideActions": true,
      "sameSideStreak": 1,
      "baselineV104PredictedResult": "banker",
      "baselineV104SameSideStreak": 1,
      "cycleApplied": false,
      "independentSupportCount": 1,
      "shoeBiasSuppressed": false,
      "askRoadSuppressed": false,
      "lockRisk": false,
      "diagnostics": {
        "direction": {
          "rawPredictedResult": "banker",
          "rawScoreTotals": {
            "banker": 0.51375,
            "player": 0.48625
          },
          "finalScoreTotals": {
            "banker": 0.51375,
            "player": 0.48625
          },
          "askRoadSuppressed": false,
          "lockGuardPrimarySource": null
        },
        "calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 33,
          "finalConfidence": 47
        },
        "shoeBias": {
          "banker": 0.5,
          "player": 0.5,
          "sampleCount": 2,
          "rawBankerRate": 0.5,
          "posteriorBankerRate": 0.5,
          "capped": false,
          "priorSampleSize": 8,
          "maximumEdge": 0.08
        },
        "roadCycles": {
          "main": {
            "detected": false,
            "direction": null,
            "source": "chronological_bead_reconstructed_big_road",
            "cycleStrengthEligible": false,
            "priorityEligible": false,
            "auxiliaryAgrees": 0,
            "auxiliaryConflicts": 0,
            "reasonText": null,
            "invalidReason": "no_complete_cycle"
          },
          "roadmapScore": {
            "banker": 0.5,
            "player": 0.5
          },
          "auxiliary": {
            "beadPlate": {
              "cycle": {
                "detected": false
              },
              "validationOnly": true,
              "countedAsIndependentSupport": false
            },
            "bigEye": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "smallRoad": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "cockroach": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            }
          }
        },
        "v104Baseline": {
          "predictedResult": "banker",
          "sameSideStreak": 1,
          "cycleApplied": false
        }
      },
      "v9BaseDirection": "banker",
      "structureDiagnostics": {
        "eligible": false,
        "direction": null,
        "reason": "insufficient_run_history",
        "source": null,
        "motifRunLengths": [],
        "repeats": 0,
        "phaseIndex": null,
        "currentPhase": "ineligible",
        "currentSide": "banker",
        "currentRunLength": 1,
        "targetRunLength": null,
        "decodedRuns": [
          {
            "side": "player",
            "length": 1
          },
          {
            "side": "banker",
            "length": 1
          }
        ]
      },
      "rankLedgerEvidence": null,
      "createdAtMs": 1793011809886
    }
  },
  "recovery": {
    "tableId": "BAV03A",
    "trendBundle": {
      "schemaVersion": 1,
      "tableId": "BAV03A",
      "shoe": "1648",
      "completedRound": 4,
      "status": "available",
      "reason": "complete"
    },
    "displayName": "MT百家樂第4桌",
    "tableType": "BAC",
    "shoe": 1648,
    "round": 5,
    "bankerCount": 3,
    "playerCount": 1,
    "tieCount": 0,
    "bankerPairCount": 0,
    "playerPairCount": 0,
    "beadPlateRaw": "01020202",
    "bigRoadRaw": "0801,,,,,#0602,0602,0602,,,",
    "bigEyeRaw": "1,,,,,,,#2,,,,,,,",
    "smallRoadRaw": "",
    "cockroachRaw": "",
    "nextBankerRaw": {
      "bead_plate": "0102020202",
      "big": "0801,,,,,#0602,0602,0602,0702,,",
      "big_eye": "1,,,,,,,#2,2,,,,,,",
      "small": "",
      "cockroach": ""
    },
    "nextPlayerRaw": {
      "bead_plate": "0102020201",
      "big": "0801,,,,,#0602,0602,0602,,,#0701,,,,,",
      "big_eye": "1,,,,,,,#2,,,,,,,#1,,,,,,,",
      "small": "",
      "cockroach": ""
    },
    "dealerName": null,
    "totalPlayers": 0,
    "roomId": 51,
    "state": null,
    "orderState": null,
    "sourceUpdatedAt": "2026-10-26T10:50:09.838Z",
    "roundBasis": "visible",
    "buildVersion": "v105",
    "prediction": {
      "source": "backend",
      "buildVersion": "v105",
      "strategyVersion": "v105",
      "targetTableId": "BAV03A",
      "targetShoe": "1648",
      "targetRound": 5,
      "predictedResult": "banker",
      "confidence": 47,
      "probabilities": {
        "banker": 50,
        "player": 50,
        "tie": 0
      },
      "scoreTotals": {
        "banker": 0.51375,
        "player": 0.48625
      },
      "scoreSources": {
        "roadmap_trend_signals": {
          "banker": 0.55,
          "player": 0.45
        },
        "ask_road_signals": {
          "banker": 0.5,
          "player": 0.5
        },
        "recent_practical_calibration": {
          "banker": 0.5,
          "player": 0.5
        },
        "shoe_banker_player_bias": {
          "banker": 0.5,
          "player": 0.5
        },
        "neutral_reserve": {
          "banker": 0.5,
          "player": 0.5
        }
      },
      "sidePredictions": {
        "tie": 14.027923784494082,
        "superSix": 39.125,
        "bankerPair": 30.054117647058824,
        "playerPair": 28.25,
        "bankerDragon": 26,
        "playerDragon": 26
      },
      "sideActions": {
        "tie": false,
        "superSix": false,
        "bankerPair": false,
        "playerPair": false,
        "bankerDragon": false,
        "playerDragon": false
      },
      "mainStreakAdjustment": {
        "applied": false,
        "reason": "v105_no_lock_risk",
        "confidencePenalty": 0,
        "finalConfidence": 47,
        "supportGroupCount": 1,
        "supportGroups": {
          "roadmap": true,
          "askRoad": false
        },
        "actionSuppressed": false
      },
      "tableRecentHitRate": null,
      "tableRecentPredictionCount": 0,
      "shortRunAdjustment": {
        "rule": "v105",
        "includedMainWeightCount": 5,
        "includedSideWeightCount": 28,
        "sideActionRateTargets": {
          "tie": 0.15,
          "superSix": 0.1,
          "bankerPair": 0.2,
          "playerPair": 0.2,
          "bankerDragon": 0.08,
          "playerDragon": 0.08
        },
        "sideTargetHitRate": 0.5,
        "baseProbabilities": {
          "banker": 50,
          "player": 50,
          "tie": 0
        }
      },
      "predictionFeatures": {
        "prediction_timing": "pre_result_context",
        "mt_context": {
          "tableId": "BAV03A",
          "displayName": "MT百家樂第4桌",
          "tableType": "BAC",
          "roomId": 51,
          "dealerName": null,
          "totalPlayers": 0,
          "state": null,
          "orderState": null,
          "sourceUpdatedAt": "2026-10-26T10:50:09.812Z",
          "shoe": 1648,
          "round": 5,
          "bankerCount": 1,
          "playerCount": 1,
          "tieCount": 0,
          "bankerPairCount": 0,
          "playerPairCount": 0
        },
        "derived_main_features": {
          "shoeStage": "early",
          "previousWinner": "banker",
          "streakLength": 1,
          "near5BankerPlayerBias": 0,
          "roadTrend": "banker",
          "longDragon": false,
          "doubleDragon": false,
          "upSlope": false,
          "downSlope": false,
          "jumpPattern": false,
          "singleJump": false,
          "doubleJump": false,
          "threeJump": false,
          "fourJump": false,
          "shortDragon": false,
          "brokenDragon": false,
          "turnDragon": false,
          "oneBankerTwoPlayer": false,
          "onePlayerTwoBanker": false,
          "rowPairRun": false,
          "bankerThenJump": false,
          "playerThenJump": false,
          "bankerThenRun": false,
          "playerThenRun": false,
          "brokenSingleJump": false,
          "longDragonToSingleJump": false,
          "singleJumpToLongDragon": false,
          "roadBreak": true,
          "derivedRoadSync": "neutral",
          "askRoadTrend": "neutral",
          "roadmapTrendSignals": {
            "singleJump": false,
            "doubleJump": false,
            "longDragon": false,
            "brokenDragon": false,
            "shortDragon": false,
            "turnDragon": false,
            "slopeRoad": false,
            "threeRunRoad": false,
            "fourRunRoad": false
          },
          "roadStructureSignals": {
            "bigRoadDominant": "neutral",
            "beadRoadDominant": "neutral",
            "roadOrderly": false,
            "roadChaotic": true
          },
          "derivedRoadStructureSignals": {
            "bigEye": "neutral",
            "smallRoad": "neutral",
            "cockroachRoad": "neutral",
            "allRed": false,
            "allBlue": false,
            "mixed": false
          },
          "askRoadSignals": {
            "bankerAdvantage": 0.555556,
            "playerAdvantage": 0.555556,
            "preferred": "neutral",
            "gap": 0
          },
          "directionCalibration": "banker_bias",
          "probabilityGap": 0,
          "tableRecentHitRate": null,
          "recentPracticalCalibration": {
            "settledDirectionalPredictionStats": null,
            "source": "unavailable",
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "shoeBankerPlayerBias": {
            "bankerCount": 1,
            "playerCount": 1,
            "gap": 0,
            "preferred": "neutral",
            "banker": 0.5,
            "player": 0.5
          },
          "actualWinner": "tie"
        },
        "unified_main_scores": {
          "roadmap_trend_signals": {
            "banker": 0.55,
            "player": 0.45
          },
          "ask_road_signals": {
            "banker": 0.5,
            "player": 0.5
          },
          "recent_practical_calibration": {
            "banker": 0.5,
            "player": 0.5
          },
          "shoe_banker_player_bias": {
            "banker": 0.5,
            "player": 0.5
          },
          "neutral_reserve": {
            "banker": 0.5,
            "player": 0.5
          }
        },
        "road_features": {
          "beadPlateRaw": "0102",
          "bigRoadRaw": "0801,,,,,#0602,,,,,",
          "bigEyeRaw": "",
          "smallRoadRaw": "",
          "cockroachRaw": "",
          "nextBankerRaw": {
            "bead_plate": "010202",
            "big": "0801,,,,,#0602,0702,,,,",
            "big_eye": "1,,,,,,,",
            "small": "",
            "cockroach": ""
          },
          "nextPlayerRaw": {
            "bead_plate": "010201",
            "big": "0801,,,,,#0602,,,,,#0701,,,,,",
            "big_eye": "2,,,,,,,",
            "small": "",
            "cockroach": ""
          }
        },
        "card_shoe_features": {
          "playerCardFaces": [
            null,
            null,
            null
          ],
          "bankerCardFaces": [
            null,
            null,
            null
          ],
          "playerCardPoints": [
            null,
            null,
            null
          ],
          "bankerCardPoints": [
            null,
            null,
            null
          ],
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerNatural": false,
          "bankerNatural": false,
          "playerDrew": false,
          "bankerDrew": false,
          "remainingRankCounts": null,
          "remainingPointCounts": {
            "0": 128,
            "1": 32,
            "2": 32,
            "3": 32,
            "4": 32,
            "5": 32,
            "6": 32,
            "7": 32,
            "8": 32,
            "9": 32
          },
          "zeroPointRate": 30.77,
          "sixPointRate": 7.69,
          "highPointRate": 15.38,
          "lowPointRate": 23.08,
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_card_rank_features": {
          "remainingRankCounts": {
            "2": 0,
            "3": 0,
            "4": 0,
            "5": 0,
            "6": 0,
            "7": 0,
            "8": 0,
            "9": 0,
            "10": 0,
            "A": 0,
            "J": 0,
            "Q": 0,
            "K": 0
          },
          "remainingRankTotal": 0,
          "remainingRankFeatureScores": {
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0
          },
          "cardsSeenTotal": null,
          "cardsRemainingTotal": null,
          "shoeProgressRatio": null
        },
        "side_prediction_rank_inputs": {
          "tie": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "superSix": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerPair": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "bankerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          },
          "playerDragon": {
            "remainingRankCounts": {
              "2": 0,
              "3": 0,
              "4": 0,
              "5": 0,
              "6": 0,
              "7": 0,
              "8": 0,
              "9": 0,
              "10": 0,
              "A": 0,
              "J": 0,
              "Q": 0,
              "K": 0
            },
            "remainingRankTotal": 0,
            "remainingRankFeatureScores": {
              "remaining_rank_pressure": 0,
              "remaining_rank_total": 0
            },
            "cardsSeenTotal": null,
            "cardsRemainingTotal": null,
            "shoeProgressRatio": null
          }
        },
        "point_features": {
          "playerPoint": null,
          "bankerPoint": null,
          "pointDiff": null,
          "playerDrew": false,
          "bankerDrew": false,
          "playerNatural": false,
          "bankerNatural": false
        },
        "side_weights": {
          "tie": {
            "tie_count": 0.1,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0.45,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0.15,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "superSix": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.1,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.35,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.2
          },
          "bankerPair": {
            "tie_count": 0,
            "banker_pair_count": 0.2,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.2,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.35,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.1,
            "remaining_rank_pressure": 0.15,
            "remaining_rank_total": 0
          },
          "playerPair": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0.2,
            "bead_road": 0,
            "big_road": 0,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0.15,
            "player_point": 0,
            "banker_point": 0,
            "point_diff": 0,
            "banker_natural": 0,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0.25,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0.2,
            "remaining_rank_pressure": 0.2,
            "remaining_rank_total": 0
          },
          "bankerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0,
            "banker_point": 0.35,
            "point_diff": 0.15,
            "banker_natural": 0.1,
            "player_natural": 0,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          },
          "playerDragon": {
            "tie_count": 0,
            "banker_pair_count": 0,
            "player_pair_count": 0,
            "bead_road": 0,
            "big_road": 0.1,
            "big_eye_road": 0,
            "small_road": 0,
            "cockroach_road": 0,
            "next_banker_road": 0,
            "next_player_road": 0,
            "shoe": 0,
            "round": 0,
            "shoe_stage": 0,
            "player_point": 0.35,
            "banker_point": 0,
            "point_diff": 0.15,
            "banker_natural": 0,
            "player_natural": 0.1,
            "banker_dragon": 0,
            "player_dragon": 0,
            "super_six": 0,
            "tie_risk": 0,
            "pair_risk": 0,
            "ask_road_conflict": 0,
            "road_chaos": 0,
            "table_side_history": 0,
            "remaining_rank_pressure": 0,
            "remaining_rank_total": 0.3
          }
        },
        "side_tuning": {
          "tie": {
            "targetActionRate": 0.15,
            "targetHitRate": 0.5
          },
          "superSix": {
            "targetActionRate": 0.1,
            "targetHitRate": 0.5
          },
          "bankerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "playerPair": {
            "targetActionRate": 0.2,
            "targetHitRate": 0.5
          },
          "bankerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          },
          "playerDragon": {
            "targetActionRate": 0.08,
            "targetHitRate": 0.5
          }
        },
        "side_predictions": {
          "tie": 14.027923784494082,
          "superSix": 39.125,
          "bankerPair": 30.054117647058824,
          "playerPair": 28.25,
          "bankerDragon": 26,
          "playerDragon": 26
        },
        "side_actions": {
          "tie": false,
          "superSix": false,
          "bankerPair": false,
          "playerPair": false,
          "bankerDragon": false,
          "playerDragon": false
        },
        "side_results": {
          "superSix": false,
          "bankerDragon": false,
          "playerDragon": false,
          "bankerPair": false,
          "playerPair": false
        },
        "table_performance": {
          "settledDirectionalPredictionStats": null,
          "directionalCalibrationSource": "unavailable",
          "recentHitRate": null,
          "recentPredictionCount": 0,
          "source": "unavailable",
          "calculable": false
        },
        "confidence_calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 33,
          "finalConfidence": 47
        },
        "main_streak_adjustment": {
          "applied": false,
          "reason": "v105_no_lock_risk",
          "confidencePenalty": 0,
          "finalConfidence": 47,
          "supportGroupCount": 1,
          "supportGroups": {
            "roadmap": true,
            "askRoad": false
          },
          "actionSuppressed": false
        },
        "v105_main_policy": {
          "strategyVersion": "v105",
          "diagnostics": {
            "direction": {
              "rawPredictedResult": "banker",
              "rawScoreTotals": {
                "banker": 0.51375,
                "player": 0.48625
              },
              "finalScoreTotals": {
                "banker": 0.51375,
                "player": 0.48625
              },
              "askRoadSuppressed": false,
              "lockGuardPrimarySource": null
            },
            "calibration": {
              "directionContribution": 0,
              "source": "v104_shadow_final_only",
              "sampleCount": 0,
              "hitRate": null,
              "minimumSamples": 20,
              "mode": "neutral_shrinkage",
              "rawConfidence": 33,
              "finalConfidence": 47
            },
            "shoeBias": {
              "banker": 0.5,
              "player": 0.5,
              "sampleCount": 2,
              "rawBankerRate": 0.5,
              "posteriorBankerRate": 0.5,
              "capped": false,
              "priorSampleSize": 8,
              "maximumEdge": 0.08
            },
            "roadCycles": {
              "main": {
                "detected": false,
                "direction": null,
                "source": "chronological_bead_reconstructed_big_road",
                "cycleStrengthEligible": false,
                "priorityEligible": false,
                "auxiliaryAgrees": 0,
                "auxiliaryConflicts": 0,
                "reasonText": null,
                "invalidReason": "no_complete_cycle"
              },
              "roadmapScore": {
                "banker": 0.5,
                "player": 0.5
              },
              "auxiliary": {
                "beadPlate": {
                  "cycle": {
                    "detected": false
                  },
                  "validationOnly": true,
                  "countedAsIndependentSupport": false
                },
                "bigEye": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "smallRoad": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                },
                "cockroach": {
                  "cycle": {
                    "detected": false
                  },
                  "priorityEligible": false,
                  "validationOnly": true,
                  "expectedColor": null,
                  "candidateDirection": null,
                  "agreesWithMain": false,
                  "conflictsWithMain": false
                }
              }
            },
            "v104Baseline": {
              "predictedResult": "banker",
              "sameSideStreak": 1,
              "cycleApplied": false
            }
          }
        },
        "v105_side_policy": {
          "strategyVersion": "v105_副預測沿用v104正式規則",
          "predictions": {
            "tie": 14.027923784494082,
            "superSix": 39.125,
            "bankerPair": 30.054117647058824,
            "playerPair": 28.25,
            "bankerDragon": 26,
            "playerDragon": 26
          },
          "actions": {
            "tie": false,
            "superSix": false,
            "bankerPair": false,
            "playerPair": false,
            "bankerDragon": false,
            "playerDragon": false
          },
          "diagnostics": {
            "rawPredictions": {
              "tie": 27.895860709592636,
              "superSix": 40.9375,
              "bankerPair": 11.176470588235295,
              "playerPair": 14.375,
              "bankerDragon": 26,
              "playerDragon": 26
            },
            "scoreCalibration": {
              "method": "train_quantile_to_existing_threshold",
              "offsets": {
                "tie": -13.867936925098554,
                "superSix": -1.8125,
                "bankerPair": 18.877647058823527,
                "playerPair": 13.875,
                "bankerDragon": 0,
                "playerDragon": 0
              },
              "actionRateTargets": {
                "tie": 0.15,
                "superSix": 0.1,
                "bankerPair": 0.2,
                "playerPair": 0.2,
                "bankerDragon": 0.08,
                "playerDragon": 0.08
              }
            },
            "primitives": {
              "T": 0,
              "B": 50,
              "P": 50,
              "R": 50,
              "S": 30,
              "Q": 50,
              "XB": 0,
              "XP": 0,
              "DB": 35,
              "DP": 35,
              "A": 100,
              "Hpair": 35,
              "H6": 35
            },
            "residuals": {
              "bankerPair": 0,
              "playerPair": 0,
              "bankerDragonShared": 35,
              "bankerDragonResidual": 0
            },
            "rank": {
              "available": false,
              "fallback": "renormalize",
              "substituted": null,
              "excluded": [
                "Q",
                "R"
              ]
            },
            "effectiveCoefficients": {
              "tie": {
                "T": 0.6335413929040736,
                "A": 0.24145860709592637,
                "S": 0.12500000000000003,
                "R": 0
              },
              "bankerPair": {
                "Q": 0,
                "S": 0.23529411764705885,
                "XB": 0.23529411764705885,
                "RB": 0.4117647058823529,
                "Hpair": 0.11764705882352942
              },
              "playerPair": {
                "Q": 0,
                "S": 0.18749999999999997,
                "XP": 0.25,
                "RP": 0.3125,
                "Hpair": 0.25
              },
              "superSix": {
                "B": 0.4375,
                "H6": 0.4375,
                "R": 0,
                "S": 0.12500000000000003
              },
              "bankerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0,
                "banker_point": 0.35,
                "point_diff": 0.15,
                "banker_natural": 0.1,
                "player_natural": 0,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              },
              "playerDragon": {
                "tie_count": 0,
                "banker_pair_count": 0,
                "player_pair_count": 0,
                "bead_road": 0,
                "big_road": 0.1,
                "big_eye_road": 0,
                "small_road": 0,
                "cockroach_road": 0,
                "next_banker_road": 0,
                "next_player_road": 0,
                "shoe": 0,
                "round": 0,
                "shoe_stage": 0,
                "player_point": 0.35,
                "banker_point": 0,
                "point_diff": 0.15,
                "banker_natural": 0,
                "player_natural": 0.1,
                "banker_dragon": 0,
                "player_dragon": 0,
                "super_six": 0,
                "tie_risk": 0,
                "pair_risk": 0,
                "ask_road_conflict": 0,
                "road_chaos": 0,
                "table_side_history": 0,
                "remaining_rank_pressure": 0,
                "remaining_rank_total": 0.3
              }
            }
          }
        },
        "v105_v10_main_policy": {
          "strategyVersion": "v105",
          "releaseVersion": "v105-v10-main.26",
          "sourceStrategy": "v105",
          "structureEligible": false,
          "diagnostics": {
            "v7RoadCycle": {
              "roads": {
                "bigEye": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": "1",
                  "playerNextColor": "2",
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "smallRoad": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                },
                "cockroach": {
                  "currentSequence": [],
                  "expectedColor": null,
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "candidateDirection": null,
                  "reason": "insufficient_rhythm_data"
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "v8AskRoad": {
              "roads": {
                "bigEye": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "smallRoad": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                },
                "cockroach": {
                  "sequence": [],
                  "decodedRuns": [],
                  "windows": {
                    "near6": [],
                    "near12": [],
                    "background24": []
                  },
                  "pattern": {
                    "primary": "unclassified",
                    "recognized": []
                  },
                  "currentPhase": "insufficient_history",
                  "expectedColor": null,
                  "reason": "current_road_missing_or_invalid",
                  "bankerNextColor": null,
                  "playerNextColor": null,
                  "vote": null
                }
              },
              "votes": {
                "banker": 0,
                "player": 0,
                "eligible": 0
              },
              "consensusDirection": null,
              "relationToV6": "fallback_v6",
              "reason": "insufficient_valid_votes"
            },
            "recentPracticalCalibration": {
              "banker": 0.5,
              "player": 0.5
            },
            "shoeBankerPlayerBias": {
              "banker": 0.5,
              "player": 0.5
            },
            "uncommonRoadStructure": {
              "eligible": false,
              "direction": null,
              "reason": "insufficient_run_history",
              "source": null,
              "motifRunLengths": [],
              "repeats": 0,
              "phaseIndex": null,
              "currentPhase": "ineligible",
              "currentSide": "banker",
              "currentRunLength": 1,
              "targetRunLength": null,
              "decodedRuns": [
                {
                  "side": "player",
                  "length": 1
                },
                {
                  "side": "banker",
                  "length": 1
                }
              ]
            }
          }
        }
      },
      "featureWeights": {
        "roadmap_trend_signals": 0.275,
        "ask_road_signals": 0.275,
        "shoe_banker_player_bias": 0.35,
        "neutral_reserve": 0.1
      },
      "releaseVersion": "v105-v10-main.26",
      "predictionTiming": "pre_result_context",
      "shadowOnly": false,
      "activationEligible": true,
      "memberVisible": true,
      "writesSideActions": true,
      "sameSideStreak": 1,
      "baselineV104PredictedResult": "banker",
      "baselineV104SameSideStreak": 1,
      "cycleApplied": false,
      "independentSupportCount": 1,
      "shoeBiasSuppressed": false,
      "askRoadSuppressed": false,
      "lockRisk": false,
      "diagnostics": {
        "direction": {
          "rawPredictedResult": "banker",
          "rawScoreTotals": {
            "banker": 0.51375,
            "player": 0.48625
          },
          "finalScoreTotals": {
            "banker": 0.51375,
            "player": 0.48625
          },
          "askRoadSuppressed": false,
          "lockGuardPrimarySource": null
        },
        "calibration": {
          "directionContribution": 0,
          "source": "v104_shadow_final_only",
          "sampleCount": 0,
          "hitRate": null,
          "minimumSamples": 20,
          "mode": "neutral_shrinkage",
          "rawConfidence": 33,
          "finalConfidence": 47
        },
        "shoeBias": {
          "banker": 0.5,
          "player": 0.5,
          "sampleCount": 2,
          "rawBankerRate": 0.5,
          "posteriorBankerRate": 0.5,
          "capped": false,
          "priorSampleSize": 8,
          "maximumEdge": 0.08
        },
        "roadCycles": {
          "main": {
            "detected": false,
            "direction": null,
            "source": "chronological_bead_reconstructed_big_road",
            "cycleStrengthEligible": false,
            "priorityEligible": false,
            "auxiliaryAgrees": 0,
            "auxiliaryConflicts": 0,
            "reasonText": null,
            "invalidReason": "no_complete_cycle"
          },
          "roadmapScore": {
            "banker": 0.5,
            "player": 0.5
          },
          "auxiliary": {
            "beadPlate": {
              "cycle": {
                "detected": false
              },
              "validationOnly": true,
              "countedAsIndependentSupport": false
            },
            "bigEye": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "smallRoad": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            },
            "cockroach": {
              "cycle": {
                "detected": false
              },
              "priorityEligible": false,
              "validationOnly": true,
              "expectedColor": null,
              "candidateDirection": null,
              "agreesWithMain": false,
              "conflictsWithMain": false
            }
          }
        },
        "v104Baseline": {
          "predictedResult": "banker",
          "sameSideStreak": 1,
          "cycleApplied": false
        }
      },
      "v9BaseDirection": "banker",
      "structureDiagnostics": {
        "eligible": false,
        "direction": null,
        "reason": "insufficient_run_history",
        "source": null,
        "motifRunLengths": [],
        "repeats": 0,
        "phaseIndex": null,
        "currentPhase": "ineligible",
        "currentSide": "banker",
        "currentRunLength": 1,
        "targetRunLength": null,
        "decodedRuns": [
          {
            "side": "player",
            "length": 1
          },
          {
            "side": "banker",
            "length": 1
          }
        ]
      },
      "rankLedgerEvidence": null,
      "createdAtMs": 1793011809886
    }
  }
} as const
